// back/server.js
require('dotenv').config(); // โหลด .env ก่อน
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const mongoose = require('mongoose'); // เพิ่ม require mongoose
const http = require('http'); // เพิ่ม require http
const { Server } = require("socket.io"); // เพิ่ม require Socket.IO Server

const connectDB = require('./config/db'); // ตรวจสอบ Path
const authRoutes = require('./routes/authRoutes'); // ตรวจสอบ Path
const dashboardRoutes = require('./routes/dashboardRoutes'); // ตรวจสอบ Path
const taskRoutes = require('./routes/taskRoutes'); // ตรวจสอบ Path
const teamRoutes = require('./routes/teamRoutes'); // ตรวจสอบ Path
const notificationRoutes = require('./routes/notificationRoutes'); // ตรวจสอบ Path

// --- Import Models และ Helpers ที่จำเป็นสำหรับ Cron Job ---
const Task = require('./models/Task'); // ตรวจสอบ Path
const User = require('./models/User'); // ตรวจสอบ Path
const Team = require('./models/Team'); // ตรวจสอบ Path
const { createNotification } = require('./utils/notificationHelper'); // ตรวจสอบ Path
const sendEmail = require('./utils/sendEmail'); // <-- Import ฟังก์ชันส่ง Email (ตรวจสอบ Path และชื่อ Function ให้ถูกต้อง)

const app = express();

// --- เชื่อมต่อ Database ---
connectDB();

// --- CORS ---
// const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
const frontendUrl = process.env.FRONTEND_URL || 'https://taskmanagement-by-takdanai.vercel.app';
console.log(`Allowing CORS for origin: ${frontendUrl}`);
app.use(cors({
    origin: frontendUrl,
    credentials: true
}));

app.options('*', cors());

// --- Middlewares ---
app.use(express.json()); // Body parser

// --- Setup Socket.IO ---
const server = http.createServer(app); // สร้าง HTTP server จาก Express app
const io = new Server(server, { // สร้าง Socket.IO server
    cors: {
        origin: frontendUrl,
        methods: ["GET", "POST"]
    }
});

// Middleware สำหรับส่ง io ไปยัง Routes (ถ้า Route ต้องการใช้ io.emit)
app.use((req, res, next) => {
    req.io = io;
    next();
});

// Socket.IO Connection Logic
io.on('connection', (socket) => {
    console.log('Socket.IO: User connected:', socket.id);

    // Event สำหรับให้ Client ส่ง UserID มาเพื่อ Join Room
    socket.on('joinRoom', (userId) => {
        if (userId) {
            console.log(`Socket ${socket.id} joining room for user ${userId}`);
            socket.join(userId.toString()); // Join a room specific to the user ID
        } else {
             console.log(`Socket ${socket.id} tried to join room without userId.`);
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket.IO: User disconnected:', socket.id);
    });

    // สามารถเพิ่ม listeners อื่นๆ สำหรับ Socket.IO ได้ที่นี่
});


// --- API Routes ---
// เส้นทางพื้นฐาน ควรอยู่ก่อน routes อื่นๆ ถ้ามี
app.get('/', (req, res) => res.send('Task Management API is running...'));

// กำหนด Routes สำหรับ API ต่างๆ
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use("/api/tasks", taskRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/notifications', notificationRoutes);


// --- Scheduled Job (Cron Job) สำหรับแจ้งเตือน Due Date / Overdue ---
// ทำงานทุกวันตอน 9 โมงเช้า ตามเวลา Asia/Bangkok
cron.schedule('* 9 * * *', async () => {
    const executionTime = new Date();
    console.log(`[${executionTime.toISOString()}] Running daily check for overdue and due soon tasks...`);

    const now = new Date();
    // Overdue คือ dueDate < ต้นวันปัจจุบัน
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    // Due Soon คือ dueDate >= ต้นวันปัจจุบัน และ <= สิ้นสุดวันของ X วันข้างหน้า
    const REMINDER_DAYS_BEFORE = 3; // ตั้งค่าแจ้งเตือนล่วงหน้า
    const reminderEndDate = new Date(now);
    reminderEndDate.setDate(now.getDate() + REMINDER_DAYS_BEFORE);
    reminderEndDate.setHours(23, 59, 59, 999);

    const overdueTaskIdsToUpdate = [];
    const dueSoonTaskIdsToUpdate = [];
    const notificationPromises = [];
    const emailPromises = [];

    try {
        // --- 1. ค้นหาและประมวลผล Tasks ที่ Overdue (ยังไม่เคยแจ้งเตือน Overdue) ---
        const overdueTasks = await Task.find({
            dueDate: { $lt: startOfToday },     // เลยกำหนด (ก่อนต้นวันนี้)
            status: { $ne: 'Completed' },      // ยังไม่เสร็จ
            overdueReminderSent: false         // ยังไม่เคยส่งแจ้งเตือน Overdue
        }).select('_id title dueDate assignee_id team_id'); // เลือก field ที่จำเป็น

        console.log(`Found ${overdueTasks.length} overdue tasks needing first reminder.`);

        for (const task of overdueTasks) {
            const formattedDueDate = task.dueDate.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
            const notificationMessage = `Task "${task.title}" is overdue! (Due: ${formattedDueDate})`;
            const emailSubject = `Overdue Task Reminder: ${task.title}`;
            const emailMessage = `Task "${task.title}" was due on ${formattedDueDate} and is still not completed. Please update the task status.\n\nTask Link: ${frontendUrl}/task/${task._id}`; // <-- ปรับ Link ตาม Frontend
            const link = `/task/${task._id}`;

            if (task.assignee_id) {
                try {
                    const user = await User.findById(task.assignee_id).select('email fname').lean();
                    if (user && user.email) {
                        console.log(`  - Overdue: Processing Task ${task._id} for Assignee: ${user.fname} (${user.email})`);
                        notificationPromises.push(createNotification(user._id.toString(), task._id, 'task_overdue', notificationMessage, link));
                        emailPromises.push(sendEmail({ email: user.email, subject: emailSubject, message: `Hi ${user.fname},\n\n${emailMessage}` }));
                        overdueTaskIdsToUpdate.push(task._id); // Mark for update only if user found and has email
                    } else { console.warn(`  - Overdue: Assignee ${task.assignee_id} not found or has no email for task ${task._id}.`); }
                } catch (userError) { console.error(`  - Overdue: Error fetching user ${task.assignee_id} for task ${task._id}:`, userError); }
            } else if (task.team_id) {
                try {
                    const team = await Team.findById(task.team_id).populate('members', 'email fname').lean(); // Populate email, fname
                    if (team && team.members && team.members.length > 0) {
                        console.log(`  - Overdue: Processing Task ${task._id} for Team: ${team.name || task.team_id} (${team.members.length} members)`);
                        let teamNotificationsSent = false;
                        team.members.forEach(member => {
                            if (member && member.email) {
                                notificationPromises.push(createNotification(member._id.toString(), task._id, 'task_overdue', notificationMessage, link));
                                emailPromises.push(sendEmail({ email: member.email, subject: emailSubject, message: `Hi ${member.fname},\n\n${emailMessage}` }));
                                teamNotificationsSent = true; // Mark that at least one member notification was attempted
                            } else { console.warn(`  - Overdue: Team member in team ${task.team_id} missing data or email for task ${task._id}.`);}
                        });
                        if(teamNotificationsSent) overdueTaskIdsToUpdate.push(task._id); // Mark for update only if notifications were sent to team members
                    } else { console.warn(`  - Overdue: Team ${task.team_id} not found or has no members for task ${task._id}.`); }
                } catch (teamError) { console.error(`  - Overdue: Error fetching team ${task.team_id} for task ${task._id}:`, teamError); }
            } else { console.warn(`  - Overdue: Task ${task._id} has no assignee or team.`); }
        }

        // --- 2. ค้นหาและประมวลผล Tasks ที่ Due Soon (ยังไม่เคยแจ้งเตือน Due Soon) ---
        const dueSoonTasks = await Task.find({
            dueDate: { $gte: startOfToday, $lte: reminderEndDate }, // อยู่ในช่วง Due Soon
            status: { $ne: 'Completed' },       // ยังไม่เสร็จ
            dueDateReminderSent: false          // ยังไม่เคยส่งแจ้งเตือน Due Soon
        }).select('_id title dueDate assignee_id team_id');

        console.log(`Found ${dueSoonTasks.length} due soon tasks needing first reminder.`);

        for (const task of dueSoonTasks) {
            const formattedDueDate = task.dueDate.toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' });
            const notificationMessage = `Task "${task.title}" is due soon (Due: ${formattedDueDate})`;
            const emailSubject = `Due Soon Task Reminder: ${task.title}`;
            const emailMessage = `Task "${task.title}" is due on ${formattedDueDate}. Please ensure it is completed on time.\n\nTask Link: ${frontendUrl}/task/${task._id}`; // <-- ปรับ Link ตาม Frontend
            const link = `/task/${task._id}`;

            if (task.assignee_id) {
                 try {
                    const user = await User.findById(task.assignee_id).select('email fname').lean();
                    if (user && user.email) {
                        console.log(`  - Due Soon: Processing Task ${task._id} for Assignee: ${user.fname} (${user.email})`);
                        notificationPromises.push(createNotification(user._id.toString(), task._id, 'task_due_soon', notificationMessage, link));
                        emailPromises.push(sendEmail({ email: user.email, subject: emailSubject, message: `Hi ${user.fname},\n\n${emailMessage}` }));
                        dueSoonTaskIdsToUpdate.push(task._id);
                    } else { console.warn(`  - Due Soon: Assignee ${task.assignee_id} not found or has no email for task ${task._id}.`); }
                 } catch (userError) { console.error(`  - Due Soon: Error fetching user ${task.assignee_id} for task ${task._id}:`, userError); }
            } else if (task.team_id) {
                try {
                    const team = await Team.findById(task.team_id).populate('members', 'email fname').lean();
                    if (team && team.members && team.members.length > 0) {
                         console.log(`  - Due Soon: Processing Task ${task._id} for Team: ${team.name || task.team_id} (${team.members.length} members)`);
                         let teamNotificationsSent = false;
                         team.members.forEach(member => {
                            if (member && member.email) {
                                notificationPromises.push(createNotification(member._id.toString(), task._id, 'task_due_soon', notificationMessage, link));
                                emailPromises.push(sendEmail({ email: member.email, subject: emailSubject, message: `Hi ${member.fname},\n\n${emailMessage}` }));
                                teamNotificationsSent = true;
                            } else { console.warn(`  - Due Soon: Team member in team ${task.team_id} missing data or email for task ${task._id}.`);}
                        });
                        if(teamNotificationsSent) dueSoonTaskIdsToUpdate.push(task._id);
                    } else { console.warn(`  - Due Soon: Team ${task.team_id} not found or has no members for task ${task._id}.`); }
                } catch (teamError) { console.error(`  - Due Soon: Error fetching team ${task.team_id} for task ${task._id}:`, teamError); }
            } else { console.warn(`  - Due Soon: Task ${task._id} has no assignee or team.`); }
        }

        // --- รอให้สร้าง Notification และส่ง Email (ใช้ Promise.allSettled เพื่อให้ทำงานต่อได้แม้บางอันจะ Error) ---
        const totalPromises = notificationPromises.length + emailPromises.length;
        if (totalPromises > 0) {
             console.log(`Attempting to process ${notificationPromises.length} notifications and ${emailPromises.length} emails...`);
             const results = await Promise.allSettled([...notificationPromises, ...emailPromises]);
             results.forEach((result, index) => {
                if (result.status === 'rejected') {
                    // แยกแยะว่าเป็น Notification หรือ Email Promise ที่ Error (ถ้าต้องการ Log ละเอียดขึ้น)
                    const type = index < notificationPromises.length ? 'Notification' : 'Email';
                    console.error(`  - Failed to process ${type} (Promise index ${index}):`, result.reason);
                }
             });
             console.log(`Finished processing notifications and emails.`);
        }


        // --- อัปเดต Flag สำหรับ Task ที่ประมวลผลแล้ว ---
        if (overdueTaskIdsToUpdate.length > 0) {
            const uniqueIds = [...new Set(overdueTaskIdsToUpdate.map(id => id.toString()))];
            console.log(`Updating ${uniqueIds.length} overdue tasks: setting overdueReminderSent=true`);
            try {
                await Task.updateMany(
                    { _id: { $in: uniqueIds.map(id => new mongoose.Types.ObjectId(id)) } },
                    { $set: { overdueReminderSent: true } }
                );
            } catch (updateError) { console.error('Error updating overdueReminderSent flag:', updateError);}
        }
        if (dueSoonTaskIdsToUpdate.length > 0) {
             const uniqueIds = [...new Set(dueSoonTaskIdsToUpdate.map(id => id.toString()))];
             console.log(`Updating ${uniqueIds.length} due soon tasks: setting dueDateReminderSent=true`);
             try {
                await Task.updateMany(
                    { _id: { $in: uniqueIds.map(id => new mongoose.Types.ObjectId(id)) } },
                    { $set: { dueDateReminderSent: true } }
                );
             } catch (updateError) { console.error('Error updating dueDateReminderSent flag:', updateError);}
        }

    } catch (error) {
        console.error('Error during daily task check main try-catch:', error);
    } finally {
         console.log(`[${new Date().toISOString()}] Finished daily task check.`);
    }
}, {
    scheduled: true,
    timezone: "Asia/Bangkok"
});
// --------------------------------------------------------------------


// --- Error Handling Middleware (ควรอยู่ท้ายสุดก่อน listen) ---
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    res.status(500).json({ message: 'An unexpected error occurred on the server.' });
});

// --- Start Server ---
// const PORT = process.env.PORT || 5001; // ใช้ Port จาก .env หรือ 5001 เป็นค่าสำรอง
// server.listen(PORT, () => { // ใช้ server.listen (จาก http)
//     console.log(`Server running on port ${PORT}`);
//     // Scheduler จะเริ่มทำงานเองตามเวลาที่ตั้งไว้ ไม่ต้องเรียก .start() ซ้ำ
// });
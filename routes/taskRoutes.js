// back/routes/taskRoutes.js
const express = require("express");
const mongoose = require('mongoose');
const Task = require("../models/Task");
const User = require('../models/User');
const Team = require('../models/Team');
const { protect, authorize } = require('../middleware/authMiddleware');
const { createNotification, findRelevantAdminOrManager } = require('../utils/notificationHelper');
const sendEmail = require('../utils/sendEmail');

const router = express.Router();

// ==============================================================
// <<< จัดลำดับ Route ใหม่: เอา Route ที่เฉพาะเจาะจงขึ้นก่อน >>>
// ==============================================================

// --- GET /api/tasks/my-work ---
router.get("/my-work", protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const userTeamId = req.user.team_id;

        if (!userId) {
            return res.status(401).json({ message: "User ID not found in token." });
        }

        // ใช้ new mongoose.Types.ObjectId() เพื่อความปลอดภัย
        const ownerCondition = [{ assignee_id: new mongoose.Types.ObjectId(userId) }];
        if (userTeamId) {
            // ตรวจสอบก่อนว่า userTeamId เป็น ObjectId ที่ถูกต้องหรือไม่ (ถ้ามาจาก token อาจจะไม่ต้อง แต่ถ้ามาจากแหล่งอื่นควรเช็ค)
            if (mongoose.Types.ObjectId.isValid(userTeamId)) {
                 ownerCondition.push({ team_id: new mongoose.Types.ObjectId(userTeamId) });
            } else {
                 console.warn(`Invalid userTeamId format in token for user ${userId}: ${userTeamId}`);
            }
        }
        const ownerOrCondition = { $or: ownerCondition };

        const now = new Date();
        const nearDueDate = new Date();
        nearDueDate.setDate(now.getDate() + 3);
        nearDueDate.setHours(23, 59, 59, 999);

        const statusCondition = { status: { $in: ['Pending', 'In Progress'] } };
        const dateCondition = { $or: [ { dueDate: { $lt: now } }, { dueDate: { $gte: now, $lte: nearDueDate } } ] };

        const tasksToShow = await Task.find({ $and: [ ownerOrCondition, statusCondition, dateCondition ] })
            .populate('assignee_id', 'fname lname username')
            .populate('team_id', 'name')
            .select('title status dueDate assignee_id team_id') // เลือก field ที่จำเป็นจริงๆ
            .sort({ dueDate: 1 });

        const [pendingInProgressCount, completedCount] = await Promise.all([
            Task.countDocuments({ $and: [ ownerOrCondition, { status: { $in: ['Pending', 'In Progress'] } } ] }),
            Task.countDocuments({ $and: [ ownerOrCondition, { status: 'Completed' } ] })
        ]);

        res.json({
            relevantTasks: tasksToShow,
            counts: { pendingInProgress: pendingInProgressCount, completed: completedCount }
        });

    } catch (error) {
        console.error("My Work Error:", error);
        if (error.name === 'CastError') { return res.status(400).json({ message: 'Invalid User or Team ID format.' }); }
        res.status(500).json({ message: "Error fetching 'My Work' data." });
    }
});

// --- GET /api/tasks/summary ---
router.get("/summary", protect, async (req, res) => {
    try {
        // <<< พิจารณาเพิ่มการกรองตามสิทธิ์ของผู้ใช้ที่นี่ด้วย >>>
        // ถ้าไม่กรอง จะเป็นการนับ Task ทั้งหมดในระบบ
        const completedTasksCount = await Task.countDocuments({ status: "Completed" });
        const pendingTasksCount = await Task.countDocuments({ status: { $in: ["Pending", "In Progress"] } });

        res.json({ completedTasksCount, pendingTasksCount });
    } catch (error) {
        console.error("Summary Error:", error);
        res.status(500).json({ message: "Error fetching summary data." });
    }
});

// --- GET /api/tasks/performance ---
router.get("/performance", protect, async (req, res) => {
    try {
        const { timeRange = 'W', groupBy = 'team' } = req.query;
        const now = new Date();
        let startDate;

        // Logic คำนวณ startDate
        switch (timeRange.toUpperCase()) {
             case 'D': startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
             case 'M': startDate = new Date(now.getFullYear(), now.getMonth(), 1); break;
             case 'Y': startDate = new Date(now.getFullYear(), 0, 1); break;
             case 'W':
             default:
                 const dayOfWeek = now.getDay();
                 startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)); // Start Monday
                 break;
        }
        startDate.setHours(0, 0, 0, 0);

        // <<< พิจารณาเพิ่มการกรองตามสิทธิ์ผู้ใช้ใน $match แรกด้วย >>>
        // const userFilter = { $or: [ { assignee_id: req.user._id }, { team_id: req.user.team_id } ] }; // ตัวอย่าง

        const pipeline = [];
        pipeline.push({
            $match: {
                status: "Completed",
                completedAt: { $gte: startDate, $lte: now },
                // ...userFilter // ถ้าต้องการกรองสิทธิ์
            }
        });

        // ส่วน Aggregation Pipeline
        let groupFieldId;
        let lookupFrom;
        let localField;
        let foreignField = "_id";
        let asField;
        let addFieldsPath;
        let ifNullDefault;

        if (groupBy === 'user' && mongoose.Types.ObjectId.isValid(req.user._id)) { // Check user role or just use assignee?
            groupFieldId = "$assignee_id";
            lookupFrom = "users";
            localField = "assignee_id";
            asField = "assigneeInfo";
            addFieldsPath = `$${asField}.username`; // Consider using username or fname+lname
            ifNullDefault = "Unassigned";
        } else { // Default to team
            groupFieldId = "$team_id";
            lookupFrom = "teams";
            localField = "team_id";
            asField = "teamInfo";
            addFieldsPath = `$${asField}.name`;
            ifNullDefault = "No Team";
        }

        // $lookup stage
        if (localField) { // Only add lookup if grouping field exists
             pipeline.push({ $lookup: { from: lookupFrom, localField: localField, foreignField: foreignField, as: asField } });
             pipeline.push({ $unwind: { path: `$${asField}`, preserveNullAndEmptyArrays: true } }); // Keep tasks even if lookup fails
             pipeline.push({ $addFields: { labelName: { $ifNull: [ addFieldsPath, ifNullDefault ] } } });
         } else {
             // Handle case where groupBy field might be missing or invalid?
             // Maybe default labelName
              pipeline.push({ $addFields: { labelName: ifNullDefault } });
         }


        // $group and $project stages
        pipeline.push({ $group: { _id: groupFieldId, label: { $first: "$labelName" }, value: { $sum: 1 } } });
        pipeline.push({ $project: { _id: 0, label: 1, value: 1 } });
        pipeline.push({ $sort: { value: -1 } });

        const results = await Task.aggregate(pipeline);

        // Format for chart library (labels and data arrays)
        const chartData = {
            labels: results.map(item => item.label || ifNullDefault), // Ensure label exists
            data: results.map(item => item.value)
        };
        res.json(chartData);

    } catch (error) {
        console.error("Performance Aggregation Error:", error);
        res.status(500).json({ message: "Error fetching performance data." });
    }
});

// --- GET /api/tasks/durations (เพิ่ม Route ใหม่นี้เข้ามา) ---
router.get('/durations', protect, async (req, res) => {
    try {
        const { timeRange = 'M' } = req.query;
        const now = new Date();
        let startDate;

        // Logic คำนวณ startDate
        switch (timeRange.toUpperCase()) {
            case 'D': startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
            case 'M': startDate = new Date(now.getFullYear(), now.getMonth(), 1); break;
            case 'Y': startDate = new Date(now.getFullYear(), 0, 1); break;
            case 'W':
            default:
                const dayOfWeek = now.getDay();
                startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1)); // Start Monday
                break;
        }
        startDate.setHours(0, 0, 0, 0);

        // สร้าง filter object
        const filter = {
            status: 'Completed',
            completedAt: { $gte: startDate, $lte: now },
            // <<< ควรเพิ่มเงื่อนไขการกรองตามสิทธิ์ผู้ใช้ที่นี่ด้วย !!! >>>
            // const userId = req.user.id;
            // const userTeamId = req.user.team_id;
            // $or: [ { assignee_id: userId }, { team_id: userTeamId } ] // ตัวอย่าง
        };

        // ค้นหา Task และเลือก field ที่จำเป็น
        const completedTasks = await Task.find(filter)
                                        .select('title createdAt completedAt') // <<< เลือก field ถูกต้อง >>>
                                        .sort({ completedAt: -1 })
                                        .limit(50)
                                        .lean();

        // คำนวณ Duration
        const durationData = completedTasks.map(task => {
            if (task.completedAt && task.createdAt) {
                const durationMs = task.completedAt.getTime() - task.createdAt.getTime();
                const durationDays = Math.ceil(durationMs / (1000 * 60 * 60 * 24));
                return { title: task.title, duration: durationDays >= 0 ? durationDays : 0 };
            }
            return null;
        }).filter(item => item !== null);

        res.json(durationData);

    } catch (error) {
        console.error("Get Task Durations Error:", error);
        res.status(500).json({ message: "Server error fetching task durations" });
    }
});

// ==============================================================
// <<< Route พื้นฐาน และ Route ที่มี Parameter ควรอยู่ต่อจากนี้ >>>
// ==============================================================

// --- GET /api/tasks (ดึง Task ทั้งหมด พร้อม Filter) ---
router.get("/", protect, async (req, res) => {
    try {
        const filter = {};
        // <<< เพิ่มเงื่อนไขการกรองตามสิทธิ์ผู้ใช้พื้นฐาน >>>
        const userId = req.user.id;
        const userTeamId = req.user.team_id;
        const userRole = req.user.role;

        // Admin/Manager เห็นหมด, User เห็นเฉพาะที่ตัวเอง Assign หรืออยู่ในทีม
        if (userRole === 'User') {
            const ownerCondition = [{ assignee_id: new mongoose.Types.ObjectId(userId) }];
             if (userTeamId && mongoose.Types.ObjectId.isValid(userTeamId)) {
                 ownerCondition.push({ team_id: new mongoose.Types.ObjectId(userTeamId) });
             }
            filter.$or = ownerCondition;
        } // ถ้าเป็น Admin/Manager ไม่ต้องใส่เงื่อนไข $or จะเห็นทั้งหมด (ยกเว้น Filter อื่นๆ)

        // เพิ่มเงื่อนไขตาม query params ที่ได้รับ
        if (req.query.status && req.query.status !== 'All') { filter.status = req.query.status; }
        if (req.query.assigneeId && mongoose.Types.ObjectId.isValid(req.query.assigneeId)) { filter.assignee_id = req.query.assigneeId; }
        if (req.query.teamId && mongoose.Types.ObjectId.isValid(req.query.teamId)) { filter.team_id = req.query.teamId; }
        if (req.query.tag) { filter.tags = { $in: [new RegExp(req.query.tag, 'i')] }; }

        const tasks = await Task.find(filter)
            .populate('assignee_id', 'fname lname username email')
            .populate('team_id', 'name')
            .sort({ createdAt: -1 });

        res.json(tasks);
    } catch (error) {
        console.error("Get All Tasks Error:", error);
        res.status(500).json({ message: "Error fetching tasks." });
    }
});

// --- POST /api/tasks (สร้าง Task) ---
router.post("/", protect, authorize(['Admin', 'Manager']), async (req, res) => {
    const { title, description, dueDate, status, tags, assignee_id, team_id } = req.body;

    console.log('[POST /api/tasks] Received request:', req.body);

     try {
        if (!title || !description || !dueDate) {
             return res.status(400).json({ message: 'Title, description, and due date are required.' }); 
            }

        if (assignee_id && !mongoose.Types.ObjectId.isValid(assignee_id)) return res.status(400).json({ message: 'Invalid Assignee ID format.' });

        if (team_id && !mongoose.Types.ObjectId.isValid(team_id)) return res.status(400).json({ message: 'Invalid Team ID format.' });

        const task = new Task({
            title, 
            description, 
            dueDate, 
            status: status || 'Pending', 
            tags,
            assignee_id: assignee_id || null,
            team_id: team_id || null,
        });
        await task.save();
        console.log(`[POST /api/tasks] Task created successfully: ${task._id}, Assignee: ${task.assignee_id}, Team: ${task.team_id}`);
        const frontendUrl = process.env.FRONTEND_URL
        const taskLink = `${frontendUrl}/task/${task._id}`;

        // ส่วนแจ้งเตือน
        if (task.team_id && !task.assignee_id) {
            console.log(`[POST /api/tasks] Attempting team notification for task ${task._id}, team ${task.team_id}`);
            try {
                const team = await Team.findById(task.team_id)
                                       .populate('members', '_id email fname')
                                       .lean();

                console.log(`[POST /api/tasks] Team found:`, team ? `ID: ${team._id}, Members Count: ${team.members?.length}`: 'Not Found');

                if (team && team.members && team.members.length > 0) {
                    const notificationPromises = [];
                    const emailPromises = [];
                    const notificationMessage = `New team task assigned: ${task.title}`; // ข้อความ Notification
                    const emailSubject = `New Team Task Assigned: ${task.title}`;        // หัวข้อ Email

                    team.members.forEach(member => {
                        if (member && member._id) {
                            console.log(`  - Queuing notification/email for member: ${member._id.toString()} (${member.email || 'No Email'})`);
                            // สร้าง Notification Promise
                            notificationPromises.push(
                                createNotification(member._id.toString(), task._id, 'team_task_assigned', notificationMessage, `/task/${task._id}`)
                                    .catch(err => console.error(`  - Failed notification for member ${member._id}:`, err))
                            );
                            // สร้าง Email Promise (ถ้ามี Email)
                            if (member.email) {
                                const emailMessage = `Hi ${member.fname || 'Team Member'},\n\nA new task "${task.title}" has been assigned to your team.\n\nDue Date: ${task.dueDate.toLocaleDateString('th-TH')}\n\nView Task: ${taskLink}`;
                                emailPromises.push(
                                    sendEmail({ email: member.email, subject: emailSubject, message: emailMessage })
                                        .catch(err => console.error(`  - Failed sending email to ${member.email}:`, err))
                                );
                            }
                        }
                    });
                    // รอให้เสร็จ (ไม่จำเป็นต้องรอผล)
                    Promise.allSettled([...notificationPromises, ...emailPromises]);
                    console.log(`[POST /api/tasks] Finished processing team notifications/emails for task ${task._id}`);
                } else {
                    console.warn(`[POST /api/tasks] Team task ${task._id} created, but team ${task.team_id} not found or has no members. No team notifications sent.`);
                }
            } catch (notifyError) {
                console.error(`[POST /api/tasks] Error during team notification process for task ${task._id}:`, notifyError);
            }
        } else if (task.assignee_id) { // --- กรณีมอบหมายให้คนเดียว ---
            console.log(`[POST /api/tasks] Attempting INDIVIDUAL notification/email for task ${task._id} to user ${task.assignee_id}`);
            const notificationMessage = `You have been assigned a new task: ${task.title}`; // ข้อความ Notification
            const emailSubject = `New Task Assigned: ${task.title}`;                // หัวข้อ Email

            // สร้าง Notification ก่อน
            createNotification(task.assignee_id.toString(), task._id, 'task_assigned', notificationMessage, `/task/${task._id}`)
                .then(() => console.log(`[POST /api/tasks] Notification created for user ${task.assignee_id}`))
                .catch(err => { console.error(`[POST /api/tasks] Failed to create notification for user ${task.assignee_id}:`, err); });

            // ดึงข้อมูล User แล้วส่ง Email
            User.findById(task.assignee_id).select('email fname').lean().then(user => {
                if (user && user.email) {
                    console.log(`  - Sending assignment email to ${user.email}`);
                    const emailMessage = `Hi ${user.fname || 'User'},\n\nYou have been assigned a new task: "${task.title}".\n\nDue Date: ${task.dueDate.toLocaleDateString('th-TH')}\n\nView Task: ${taskLink}`;
                    sendEmail({ email: user.email, subject: emailSubject, message: emailMessage })
                        .catch(err => console.error(`  - Failed sending assignment email to ${user.email}:`, err));
                } else {
                    console.warn(`[POST /api/tasks] Assignee ${task.assignee_id} for task ${task._id} has no email. Email not sent.`);
                }
            }).catch(err => console.error(`[POST /api/tasks] Error fetching user ${task.assignee_id} for email:`, err));

        } else {
            console.log(`[POST /api/tasks] Task ${task._id} created with no assignee and no team.`);
        }

        res.status(201).json(task); // ส่ง Response กลับ

    } catch (error) {
        console.error("[POST /api/tasks] Create Task Error:", error);
        if (error.name === 'ValidationError') return res.status(400).json({ message: error.message });
        res.status(500).json({ message: error.message || "Error creating task." });
    }
});

// --- GET /api/tasks/:id (ดึง Task ตาม ID) ---
router.get("/:id", protect, async (req, res) => {
    try {
        const taskId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(taskId)) { return res.status(400).json({ message: "Invalid Task ID format." }); }

        const task = await Task.findById(taskId)
            .populate('assignee_id', 'fname lname username email')
            .populate('team_id', 'name');

        if (!task) { return res.status(404).json({ message: "Task not found." }); }

        // ตรวจสอบสิทธิ์
        const userId = req.user.id;
        const userTeamId = req.user.team_id ? req.user.team_id.toString() : null;
        const userRole = req.user.role;
        const taskAssigneeId = task.assignee_id?._id?.toString();
        const taskTeamId = task.team_id?._id?.toString();

        const canView = userRole === 'Admin' || userRole === 'Manager' ||
                        (taskAssigneeId && taskAssigneeId === userId) ||
                        (taskTeamId && taskTeamId === userTeamId);

        if (!canView) { return res.status(403).json({ message: "Forbidden: You do not have permission to view this task." }); }

        res.json(task);
    } catch (error) {
        console.error("Get Task By ID Error:", error);
        res.status(500).json({ message: "Error fetching task details." });
    }
});

// --- PUT /api/tasks/:id (แก้ไข Task - ใช้ Logic ที่รวมแล้วอันเดียว) ---
router.put("/:id", protect, async (req, res) => { // ลบ authorize ออกก่อน เพราะ User ต้องเข้าได้ แต่จำกัดสิทธิ์ข้างใน
    try {
        const taskId = req.params.id;
        const userRole = req.user.role;
        const userId = req.user.id; // ID ของผู้ใช้ที่กำลังแก้ไข

        if (!mongoose.Types.ObjectId.isValid(taskId)) return res.status(400).json({ message: "Invalid Task ID format." });

        // --- ดึงข้อมูล Task เดิมก่อน เพื่อเปรียบเทียบ และเช็คสิทธิ์ ---
        // ดึง needsCompletionApproval มาด้วย
        const existingTask = await Task.findById(taskId).select('title assignee_id team_id status completedAt needsCompletionApproval');
        if (!existingTask) return res.status(404).json({ message: "Task not found" });

        const oldAssigneeId = existingTask.assignee_id ? existingTask.assignee_id.toString() : null;
        const oldTeamId = existingTask.team_id ? existingTask.team_id.toString() : null;

        let updateData = {};
        let allowedToUpdate = false;
        let requiresApprovalCheck = false; // Flag ว่าต้องเช็คการ Approve/Reject หรือไม่

        // --- Logic กำหนด updateData และ allowedToUpdate ตาม Role ---
        if (userRole === 'Admin' || userRole === 'Manager') {
            allowedToUpdate = true;
            requiresApprovalCheck = true; // Admin/Manager อาจต้อง Approve/Reject
            const { title, description, dueDate, status, tags, assignee_id, team_id } = req.body;

            // ... Validation (เหมือนเดิม) ...
             if (status && !['Pending', 'In Progress', 'Completed'].includes(status)) return res.status(400).json({ message: "Invalid status value." });
             if (assignee_id && assignee_id !== '' && !mongoose.Types.ObjectId.isValid(assignee_id)) return res.status(400).json({ message: 'Invalid Assignee ID format.' });
             if (team_id && team_id !== '' && !mongoose.Types.ObjectId.isValid(team_id)) return res.status(400).json({ message: 'Invalid Team ID format.' });

            // สร้าง updateData (เหมือนเดิม แต่จะปรับ status และ needsCompletionApproval ทีหลัง)
            if (title !== undefined) updateData.title = title;
            if (description !== undefined) updateData.description = description;
            if (dueDate !== undefined) updateData.dueDate = dueDate;
            if (status !== undefined) updateData.status = status; // เก็บ status ที่ส่งมาก่อน
            if (tags !== undefined) updateData.tags = tags;
            if (assignee_id !== undefined) updateData.assignee_id = assignee_id || null;
            if (team_id !== undefined) updateData.team_id = team_id || null;
            // จัดการ team/assignee conflict (เหมือนเดิม)
            if (updateData.assignee_id) updateData.team_id = null;
            else if (updateData.team_id) updateData.assignee_id = null;

            // *** Logic ใหม่: จัดการ needsCompletionApproval และ completedAt สำหรับ Admin/Manager ***
            const newStatus = updateData.status !== undefined ? updateData.status : existingTask.status;

            if (newStatus === 'Completed') {
                updateData.needsCompletionApproval = false; // Admin/Manager ตั้ง -> ไม่ต้องรอ Approve
                
                updateData.completedAt = new Date();

                // *** (Optional) ถ้าเป็นการ Approve งานที่ User ส่งมา -> แจ้ง User ***
                if (existingTask.needsCompletionApproval && updateData.status !== undefined) { // เช็คว่าก่อนหน้านี้รอ Approve และมีการส่ง status มา
                    // ใช้ createNotification จาก ../utils/notificationHelper
                    if (existingTask.assignee_id) {
                        createNotification(
                            existingTask.assignee_id.toString(),
                            taskId,
                            'task_approved', // Event type ใหม่
                            `Your task "${updateData.title || existingTask.title}" has been approved by ${req.user.fname}.`, // ใช้ req.user.fname จาก token
                            `/task/${taskId}`
                        ).catch(err => console.error(`[Approval Notify] Failed approve notify for ${existingTask.assignee_id}:`, err));
                    }
                }
            } else { // ถ้า Status ใหม่ ไม่ใช่ Completed
                // ถ้างานเดิมรอ Approve อยู่ แล้ว Admin/Manager เปลี่ยนเป็นสถานะอื่น (Reject)
                if (existingTask.needsCompletionApproval && updateData.status !== undefined) {
                     updateData.needsCompletionApproval = false;
                     updateData.completedAt = null;
                     // *** (Optional) แจ้ง User ว่างานถูก Reject ***
                     if (existingTask.assignee_id) {
                        createNotification(
                            existingTask.assignee_id.toString(),
                            taskId,
                            'task_rejected', // Event type ใหม่
                            `Task "${updateData.title || existingTask.title}" needs revision (Status set to ${newStatus} by ${req.user.fname}).`,
                            `/task/${taskId}`
                         ).catch(err => console.error(`[Approval Notify] Failed reject notify for ${existingTask.assignee_id}:`, err));
                     }
                } else if (existingTask.status === 'Completed' && newStatus !== 'Completed') {
                    // ถ้าเปลี่ยนจาก Completed (ที่ Approve แล้ว) กลับเป็นสถานะอื่น
                    updateData.completedAt = null; // เอาเวลาเสร็จออก
                    updateData.needsCompletionApproval = false; // ก็ไม่ต้องรอ Approve
                }
            }

        } else if (userRole === 'User') {
            // --- ปรับปรุง Logic การตรวจสอบสิทธิ์สำหรับ User ---
            const isDirectAssignee = existingTask.assignee_id && existingTask.assignee_id.equals(userId);
            // ดึง team_id ของ User ที่กำลัง request มาจาก req.user (ที่ได้จาก Middleware)
            const userTeamId = req.user.team_id ? req.user.team_id.toString() : null;
            // ตรวจสอบว่าเป็น Task ของทีมที่ User อยู่ และไม่ได้ Assign ให้คนอื่น
            const isTeamMemberUpdatingTeamTask = existingTask.team_id &&
                                                 userTeamId &&
                                                 existingTask.team_id.toString() === userTeamId &&
                                                 !existingTask.assignee_id; // เช็คว่า assignee_id ต้องไม่มีค่า

            // อนุญาตให้อัปเดตถ้าเป็น Assignee โดยตรง หรือ เป็นสมาชิกทีมที่กำลังอัปเดตงานของทีม (ที่ไม่ได้ Assign ให้คนอื่น)
            if (!isDirectAssignee && !isTeamMemberUpdatingTeamTask) {
                 return res.status(403).json({ message: "Forbidden: You can only update tasks assigned directly to you or unassigned tasks belonging to your team." });
            }
            // -----------------------------------------------------

            // User สามารถอัปเดตได้แค่ status (โค้ดส่วนนี้เหมือนเดิม)
            const { status } = req.body;
            if (Object.keys(req.body).length === 1 && req.body.hasOwnProperty('status')) {
                if (status && ['Pending', 'In Progress', 'Completed'].includes(status)) {
                    if (status !== existingTask.status || (status === 'Completed' && existingTask.needsCompletionApproval)) {
                        allowedToUpdate = true;
                        if (status === 'Completed') {
                            // --- โค้ดเดิมของคุณ ไม่ต้องแก้ ---
                            updateData.status = 'Completed';
                            updateData.needsCompletionApproval = true;
                            updateData.completedAt = null;
                            // ----------------------------------
    
                            // (Optional) Notify Admin/Manager
                            const relevantAdminOrManagerIds = await findRelevantAdminOrManager(existingTask);
    
                            // +++ เพิ่ม Log ตรงนี้ +++
                            console.log('[DEBUG] relevantAdminOrManagerIds:', relevantAdminOrManagerIds);
                            // +--------------------+
    
                            if (relevantAdminOrManagerIds && relevantAdminOrManagerIds.length > 0) {
                                 // +++ เพิ่ม Log ตรงนี้ +++
                                 console.log('[DEBUG] Entering map to create notifications for admins:', relevantAdminOrManagerIds);
                                 // +--------------------+
    
                                const notificationPromises = relevantAdminOrManagerIds.map(adminId => {
                                     // +++ เพิ่ม Log ตรงนี้ +++
                                     console.log(`[DEBUG] Mapping adminId: ${adminId} (Type: ${typeof adminId})`);
                                     // +--------------------+
                                    return createNotification( // <<< ต้องมี return ตรงนี้ด้วยนะครับ
                                        adminId,
                                        taskId,
                                        'task_pending_approval',
                                        `Task "${existingTask.title}" submitted by ${req.user.fname} requires approval.`,
                                        `/task/${taskId}`
                                    ).catch(err => console.error(`[Approval Notify] Failed pending notify for admin ${adminId}:`, err));
                                 });
                                Promise.allSettled(notificationPromises);
                            } else {
                                 // +++ เพิ่ม Log ตรงนี้ (Optional) +++
                                 console.log('[Notify Check] No relevant admins/managers found or returned array was empty/null.');
                                 // +--------------------------------+
                            }
                        } else { // <<< ส่วน else นี้ไม่ต้องยุ่ง
                            updateData.status = status;
                            updateData.needsCompletionApproval = false;
                            updateData.completedAt = null;
                        }
                    } else {
                        allowedToUpdate = false;
                    }
                } else { return res.status(400).json({ message: "Invalid status value." }); }
            } else if (Object.keys(req.body).length > 0) { return res.status(403).json({ message: "Forbidden: Users can only update task status." }); }
        }
        // --- ทำการ Update ถ้าได้รับอนุญาตและมีข้อมูลที่จะ Update จริงๆ ---
        if (allowedToUpdate && Object.keys(updateData).length > 0) {
            console.log(`[PUT /api/tasks/:id] Updating Task ${taskId} with data:`, updateData);
            const updatedTaskResult = await Task.findByIdAndUpdate(taskId, updateData, { new: true, runValidators: true })
                                        .populate('assignee_id', '_id email fname username') // Populate ให้ครบถ้วน
                                        .populate('team_id', '_id name');

            // ส่วน Logic การแจ้งเตือนการเปลี่ยน Assignee/Team (เหมือนเดิม)
            const currentNewAssigneeId = updatedTaskResult.assignee_id?._id?.toString();
            const currentNewTeamId = updatedTaskResult.team_id?._id?.toString();
            const newAssigneeIdFromBody = updateData.assignee_id !== undefined ? (updateData.assignee_id ? updateData.assignee_id.toString() : null) : oldAssigneeId; // ต้องคำนวณใหม่ให้แม่นยำ
            const newTeamIdFromBody = updateData.team_id !== undefined ? (updateData.team_id ? updateData.team_id.toString() : null) : oldTeamId; // ต้องคำนวณใหม่ให้แม่นยำ

            const frontendUrl = process.env.FRONTEND_URL
            const taskLink = `${frontendUrl}/task/${updatedTaskResult._id}`;

            if (newAssigneeIdFromBody && newAssigneeIdFromBody !== oldAssigneeId) {
                 // ... (Code การแจ้งเตือน Assignee ใหม่ เหมือนเดิม) ...
                 console.log(`[PUT /api/tasks/:id] Assignee changed. Notifying new individual assignee: ${newAssigneeIdFromBody}`);
                 const notificationMessage = `Task assigned to you: ${updatedTaskResult.title}`;
                 const emailSubject = `Task Assigned to You: ${updatedTaskResult.title}`;
                 createNotification(newAssigneeIdFromBody, updatedTaskResult._id, 'task_assigned', notificationMessage, taskLink)
                     .catch(err => { console.error(`[PUT /api/tasks/:id] Failed notification for assignment update to user ${newAssigneeIdFromBody}:`, err); });
                 User.findById(newAssigneeIdFromBody).select('email fname').lean().then(newUser => {
                      if (newUser && newUser.email) {
                         const emailMessage = `Hi ${newUser.fname || 'User'},\n\nYou have been assigned the task: "${updatedTaskResult.title}".\n\nDue Date: ${updatedTaskResult.dueDate.toLocaleDateString('th-TH')}\n\nView Task: ${taskLink}`;
                         sendEmail({ email: newUser.email, subject: emailSubject, message: emailMessage })
                              .catch(err => console.error(`  - Failed sending reassignment email to ${newUser.email}:`, err));
                      }
                  }).catch(err => console.error(`[PUT /api/tasks/:id] Error fetching user ${newAssigneeIdFromBody} for email:`, err));

            } else if (newTeamIdFromBody && newTeamIdFromBody !== oldTeamId && !currentNewAssigneeId) {
                 // ... (Code การแจ้งเตือน Team ใหม่ เหมือนเดิม) ...
                  console.log(`[PUT /api/tasks/:id] Assignment changed. Notifying new team: ${newTeamIdFromBody}`);
                  try {
                     const team = await Team.findById(newTeamIdFromBody).populate('members', '_id email fname').lean();
                     if (team && team.members && team.members.length > 0) {
                         const notificationPromises = []; const emailPromises = [];
                         const notificationMessage = `New team task assigned: ${updatedTaskResult.title}`;
                         const emailSubject = `New Team Task Assigned: ${updatedTaskResult.title}`;
                         team.members.forEach(member => {
                             if (member && member._id) {
                                 notificationPromises.push(createNotification(member._id.toString(), updatedTaskResult._id, 'team_task_assigned', notificationMessage, taskLink).catch(err => console.error(`  - Failed team notification for member ${member._id}:`, err)));
                                 if (member.email) {
                                     const emailMessage = `Hi ${member.fname || 'Team Member'},\n\nA new task "${updatedTaskResult.title}" has been assigned to your team.\n\nDue Date: ${updatedTaskResult.dueDate.toLocaleDateString('th-TH')}\n\nView Task: ${taskLink}`;
                                     emailPromises.push(sendEmail({ email: member.email, subject: emailSubject, message: emailMessage }).catch(err => console.error(`  - Failed sending team email to ${member.email}:`, err)));
                                 }
                             }
                         });
                         Promise.allSettled([...notificationPromises, ...emailPromises]);
                     }
                  } catch (teamNotifyError) { console.error(`[PUT /api/tasks/:id] Error during new team notification process for task ${updatedTaskResult._id}:`, teamNotifyError); }
            }

            res.json(updatedTaskResult);

        } else if (!allowedToUpdate && Object.keys(updateData).length === 0) {
            // ถ้าไม่มีการเปลี่ยนแปลงข้อมูลเลย หรือกดสถานะเดิม (ที่ไม่ใช่ Completed รอ Approve)
             console.log(`[PUT /api/tasks/:id] No effective update applied for Task ${taskId}. Returning existing task.`);
             // Populate ให้เหมือนตอน success เพื่อให้ response structure เหมือนกัน
             const taskToSend = await Task.findById(taskId)
                                       .populate('assignee_id', '_id email fname username')
                                       .populate('team_id', '_id name');
             res.json(taskToSend);
        } else {
            // กรณีอื่นๆ ที่ไม่ควรเกิดขึ้น แต่ใส่ไว้เผื่อ
            res.status(400).json({ message: "Update condition not met or no data provided." });
        }

    } catch (error) {
        // ... (Error Handling เหมือนเดิม) ...
         console.error("[PUT /api/tasks/:id] Update Task Error:", error);
         if (error.name === 'CastError') return res.status(400).json({ message: `Invalid ID format in request: ${error.path}=${error.value}` });
         if (error.name === 'ValidationError') return res.status(400).json({ message: error.message });
         res.status(500).json({ message: error.message || "An error occurred while updating the task." });
    }
});


// --- DELETE /api/tasks/:id (ลบ Task - อันเดียว) ---
router.delete("/:id", protect, authorize(['Admin', 'Manager']), async (req, res) => {
    try {
        const taskId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(taskId)) { return res.status(400).json({ message: "Invalid Task ID format." }); }

        // <<< พิจารณาเพิ่มการตรวจสอบสิทธิ์ Manager ว่าลบได้เฉพาะ Task ในทีมหรือไม่ >>>

        const task = await Task.findByIdAndDelete(taskId);
        if (!task) { return res.status(404).json({ message: "Task not found" }); }

        // <<< ถ้ามีการใช้ Collection อื่นที่เชื่อมโยงกับ Task (เช่น Comments) ควรลบข้อมูลที่เกี่ยวข้องด้วย >>>

        res.json({ message: "Task deleted successfully" });
    } catch (error) {
        console.error("Delete Task Error:", error);
        res.status(500).json({ message: error.message || "Error deleting task." });
    }
});


module.exports = router;
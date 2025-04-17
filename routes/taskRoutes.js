// back/routes/taskRoutes.js
const express = require("express");
const mongoose = require('mongoose');
const Task = require("../models/Task");
const User = require('../models/User');
const Team = require('../models/Team');
const { protect, authorize } = require('../middleware/authMiddleware');
const { createNotification } = require('../utils/notificationHelper');

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
     try {
        if (!title || !description || !dueDate) { return res.status(400).json({ message: 'Title, description, and due date are required.' }); }
        if (assignee_id && !mongoose.Types.ObjectId.isValid(assignee_id)) return res.status(400).json({ message: 'Invalid Assignee ID format.' });
        if (team_id && !mongoose.Types.ObjectId.isValid(team_id)) return res.status(400).json({ message: 'Invalid Team ID format.' });

        const task = new Task({
            title, description, dueDate, status, tags,
            assignee_id: assignee_id || null,
            team_id: team_id || null,
            // createdBy: req.user.id // พิจารณาเพิ่ม field นี้
        });
        await task.save();

        // ส่วนแจ้งเตือน
        if (task.team_id && !task.assignee_id) {
            try {
                const team = await Team.findById(task.team_id).select('members').lean();
                if (team && team.members && team.members.length > 0) {
                    const notificationPromises = team.members.map(memberId => {
                        if (memberId) { return createNotification(memberId.toString(), task._id, 'team_task_assigned', `New team task assigned: ${task.title}`, `/task/${task._id}`); }
                        return Promise.resolve();
                    });
                    await Promise.allSettled(notificationPromises);
                }
            } catch (notifyError) { console.error(`Error sending team notifications for task ${task._id}:`, notifyError); }
        } else if (task.assignee_id) {
             createNotification( task.assignee_id.toString(), task._id, 'task_assigned', `You have been assigned a new task: ${task.title}`, `/task/${task._id}` )
                 .catch(err => { console.error(`Failed to create notification for user ${task.assignee_id} for task ${task._id}:`, err); });
        }
        res.status(201).json(task);
     } catch (error) {
         console.error("Create Task Error:", error);
         if (error.name === 'ValidationError') { return res.status(400).json({ message: error.message }); }
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
router.put("/:id", protect, async (req, res) => {
    try {
        const taskId = req.params.id;
        const userRole = req.user.role;
        const userId = req.user.id;

        if (!mongoose.Types.ObjectId.isValid(taskId)) { return res.status(400).json({ message: "Invalid Task ID format." }); }

        // <<< ดึงข้อมูล Task เดิมมาโดยไม่ populate assignee_id ก่อน เพื่อเอา ID เดิมมาใช้ >>>
        const existingTask = await Task.findById(taskId).select('assignee_id status'); // เลือกเฉพาะ field ที่จำเป็น
        if (!existingTask) { return res.status(404).json({ message: "Task not found" }); }

        const oldAssigneeId = existingTask.assignee_id ? existingTask.assignee_id.toString() : null;
        let updateData = {};
        let allowedToUpdate = false;
        let newAssigneeIdFromBody = null; // เก็บค่า assignee_id ที่ส่งมาจาก body

        // Logic แยกตาม Role
        if (userRole === 'Admin' || userRole === 'Manager') {
            allowedToUpdate = true;
            const { title, description, dueDate, status, tags, assignee_id, team_id } = req.body;

            // Validate inputs
            if (status && !['Pending', 'In Progress', 'Completed'].includes(status)) return res.status(400).json({ message: "Invalid status value." });
            if (assignee_id && assignee_id !== '' && !mongoose.Types.ObjectId.isValid(assignee_id)) return res.status(400).json({ message: 'Invalid Assignee ID format.' });
            if (team_id && team_id !== '' && !mongoose.Types.ObjectId.isValid(team_id)) return res.status(400).json({ message: 'Invalid Team ID format.' });

            // สร้าง updateData เฉพาะ field ที่มีการส่งค่ามาจริงๆ
            if (title !== undefined) updateData.title = title;
            if (description !== undefined) updateData.description = description;
            if (dueDate !== undefined) updateData.dueDate = dueDate;
            if (status !== undefined) updateData.status = status;
            if (tags !== undefined) updateData.tags = tags;
            // ถ้าส่ง assignee_id เป็น "" หรือ null ให้เซ็ตเป็น null ใน DB
            if (assignee_id !== undefined) {
                 updateData.assignee_id = assignee_id || null;
                 newAssigneeIdFromBody = updateData.assignee_id ? updateData.assignee_id.toString() : null; // <-- กำหนดค่า assignee ใหม่จาก body
            } else {
                 newAssigneeIdFromBody = oldAssigneeId; // ถ้าไม่ส่งมา ให้ใช้ค่าเดิม
            }
            if (team_id !== undefined) updateData.team_id = team_id || null;

            // Logic การตั้งค่า completedAt
            const currentStatus = updateData.status !== undefined ? updateData.status : existingTask.status; // ใช้ status ใหม่ถ้ามี, ถ้าไม่มีใช้ของเดิม
            if (currentStatus === "Completed" && existingTask.status !== "Completed") {
                updateData.completedAt = new Date();
            } else if (currentStatus !== "Completed" && existingTask.status === "Completed") {
                updateData.completedAt = null; // ล้างค่าถ้า status ไม่ใช่ Completed แล้ว
            }

        } else if (userRole === 'User') {
            if (existingTask.assignee_id && existingTask.assignee_id.equals(userId)) {
                const { status } = req.body;
                if (Object.keys(req.body).length === 1 && req.body.hasOwnProperty('status')) {
                    if (status && ['Pending', 'In Progress', 'Completed'].includes(status)) {
                        if (status !== existingTask.status) { // เช็คว่า status เปลี่ยนจริงไหม
                            allowedToUpdate = true;
                            updateData.status = status;
                            if (status === "Completed") { updateData.completedAt = new Date(); }
                            else if (existingTask.status === "Completed") { updateData.completedAt = null; }
                        } // ถ้า status เดิม ไม่ต้องทำอะไร
                    } else { return res.status(400).json({ message: "Invalid status value." }); }
                } else if (Object.keys(req.body).length > 0) {
                    return res.status(403).json({ message: "Forbidden: Users can only update task status." });
                }
            } else { return res.status(403).json({ message: "Forbidden: You can only update tasks assigned to you." }); }
            newAssigneeIdFromBody = oldAssigneeId; // User ไม่สามารถเปลี่ยน assignee ได้ ใช้ค่าเดิม
        } else { return res.status(403).json({ message: "Forbidden: Insufficient permissions." }); }

        // --- ทำการ Update ถ้าได้รับอนุญาตและมีข้อมูลที่จะ Update จริงๆ ---
        if (allowedToUpdate && Object.keys(updateData).length > 0) {
            // ทำการ Update ข้อมูล Task
            const updatedTaskResult = await Task.findByIdAndUpdate(taskId, updateData, { new: true, runValidators: true })
                                        .populate('assignee_id', 'fname lname username email') // Populate หลังจาก Update เสร็จ
                                        .populate('team_id', 'name');

            // ค่า Assignee ID *หลัง* การ Update (อาจจะเป็น null ถ้าถูกลบ)
            const currentNewAssigneeId = updatedTaskResult.assignee_id ? updatedTaskResult.assignee_id._id.toString() : null; // <-- ดึง ID จาก Object ที่ populate มา

            // สร้าง Notification ถ้ามีการเปลี่ยน Assignee (assignee ใหม่ไม่ใช่ null และไม่เหมือนเดิม)
            if (newAssigneeIdFromBody && newAssigneeIdFromBody !== oldAssigneeId) {
                // <<< ใช้ newAssigneeIdFromBody ที่ได้จาก req.body เพื่อส่ง Notification >>>
                // <<< เพราะ updatedTaskResult.assignee_id อาจจะยังเป็น Object เต็มอยู่ >>>
                const notificationMessage = `Task assigned to you: ${updatedTaskResult.title}`;

                // +++ เพิ่ม DEBUG LOG ตรงนี้ +++
                console.log('--- DEBUG: Before calling createNotification in PUT /:id ---');
                console.log('newAssigneeIdFromBody TYPE:', typeof newAssigneeIdFromBody); // <-- ค่า ID ที่จะส่ง
                console.log('newAssigneeIdFromBody VALUE:', newAssigneeIdFromBody);
                console.log('updatedTaskResult._id TYPE:', typeof updatedTaskResult._id);
                console.log('updatedTaskResult._id VALUE:', updatedTaskResult._id);
                console.log('----------------------------------------------------------');
                // +++ สิ้นสุด DEBUG LOG +++

                // บรรทัดที่เรียก createNotification
                createNotification( newAssigneeIdFromBody, updatedTaskResult._id, 'task_assigned', notificationMessage, `/task/${updatedTaskResult._id}` )
                    .catch(err => { console.error(`Failed to create notification for assignment update to user ${newAssigneeIdFromBody} for task ${updatedTaskResult._id}:`, err); });
            }

            // <<< อาจจะเพิ่ม Notification เมื่อ Task เสร็จสมบูรณ์ >>>
            if (updateData.status === "Completed" && existingTask.status !== "Completed") {
                // ... (ส่วน Notification Task Completed ถ้าต้องการ) ...
                // ควรพิจารณาส่ง Notification ให้ Manager หรือ Creator ด้วย
                // ตัวอย่าง: แจ้งเตือน Manager/Admin ทุกคน
                // const adminsAndManagers = await User.find({ role: { $in: ['Admin', 'Manager'] } }).select('_id');
                // adminsAndManagers.forEach(admin => {
                //     if (admin._id.toString() !== newAssigneeIdFromBody) { // ไม่ต้องแจ้งตัวเอง ถ้าเป็น Admin/Manager ที่ complete งาน
                //          createNotification(admin._id.toString(), updatedTaskResult._id, 'task_completed', `Task '${updatedTaskResult.title}' completed by ${updatedTaskResult.assignee_id?.username || 'N/A'}`, `/task/${updatedTaskResult._id}`)
                //             .catch(err => console.error(`Failed to notify admin ${admin._id} about task completion:`, err));
                //     }
                // });
            }

            res.json(updatedTaskResult); // ส่ง Task ที่ Update และ Populate แล้วกลับไป

        } else {
             // ไม่มีข้อมูลให้อัปเดต หรือไม่มีสิทธิ์
             // ถ้าไม่มีการเปลี่ยนแปลง ให้ populate ข้อมูลเดิมเพื่อส่งกลับไปให้เหมือนกรณีมีการ update
             const taskToSend = await Task.findById(taskId)
                                       .populate('assignee_id', 'fname lname username email')
                                       .populate('team_id', 'name');
             res.json(taskToSend);
        }

    } catch (error) {
        console.error("Update Task Error:", error);
        if (error.name === 'CastError' && error.path === 'assignee_id') { return res.status(400).json({ message: `Invalid Assignee ID format in request body: ${error.value}`});}
        if (error.name === 'CastError') { return res.status(400).json({ message: `Invalid ID format: ${error.path}` }); }
        if (error.name === 'ValidationError') { return res.status(400).json({ message: error.message }); }
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
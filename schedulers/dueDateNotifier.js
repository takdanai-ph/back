// back/schedulers/dueDateNotifier.js
const cron = require('node-cron');
const mongoose = require('mongoose');
const Task = require('../models/Task'); // ตรวจสอบ Path ให้ถูกต้อง
const Team = require('../models/Team');   // ตรวจสอบ Path ให้ถูกต้อง
const { createNotification } = require('../utils/notificationHelper'); // ตรวจสอบ Path ให้ถูกต้อง

const REMINDER_DAYS_BEFORE = 3; // แจ้งเตือนล่วงหน้ากี่วัน (ปรับได้)

const scheduleDueDateChecks = () => {
    // ตั้งเวลาทำงาน: '0 9 * * *' คือ ทุกวัน เวลา 9:00 น. (Asia/Bangkok)
    cron.schedule('0 9 * * *', async () => {
        const executionTime = new Date();
        console.log(`[${executionTime.toISOString()}] Running due date reminder check...`);

        try {
            const now = new Date();
            const reminderStartDate = new Date(now);
            reminderStartDate.setHours(0, 0, 0, 0); // เริ่มจากต้นวันปัจจุบัน

            const reminderEndDate = new Date(now);
            reminderEndDate.setDate(now.getDate() + REMINDER_DAYS_BEFORE);
            reminderEndDate.setHours(23, 59, 59, 999); // สิ้นสุดวันของ X วันข้างหน้า

            console.log(`Checking tasks due between ${reminderStartDate.toISOString()} and ${reminderEndDate.toISOString()}`);

            const tasksToNotify = await Task.find({
                status: { $ne: 'Completed' },
                dueDate: { $gte: reminderStartDate, $lte: reminderEndDate },
                dueDateReminderSent: false
            }).select('_id title dueDate assignee_id team_id');

            console.log(`Found ${tasksToNotify.length} tasks needing reminder.`);

            if (tasksToNotify.length === 0) {
                console.log('No tasks require reminder notifications.');
                return;
            }

            const notificationPromises = [];
            const taskIdsToUpdate = [];

            for (const task of tasksToNotify) {
                const formattedDueDate = task.dueDate.toLocaleDateString('th-TH', {
                    year: 'numeric', month: 'long', day: 'numeric'
                });
                const message = `Task "${task.title}" is due on ${formattedDueDate}`;
                const link = `/task/${task._id}`;

                if (task.assignee_id) {
                    console.log(`  - Scheduling reminder for task ${task._id} (Assignee: ${task.assignee_id})`);
                    notificationPromises.push(
                        createNotification(task.assignee_id.toString(), task._id, 'due_date_reminder', message, link)
                            .catch(err => console.error(`    - Failed notification for assignee ${task.assignee_id} on task ${task._id}:`, err)) // เพิ่ม catch error รายตัว
                    );
                    taskIdsToUpdate.push(task._id);
                } else if (task.team_id) {
                    console.log(`  - Scheduling reminder for task ${task._id} (Team: ${task.team_id})`);
                    try {
                        const team = await Team.findById(task.team_id).select('members').lean();
                        if (team && team.members && team.members.length > 0) {
                            console.log(`    - Found ${team.members.length} members in team ${task.team_id}`);
                            team.members.forEach(memberId => {
                                if (memberId) {
                                    notificationPromises.push(
                                        createNotification(memberId.toString(), task._id, 'due_date_reminder', message, link)
                                            .catch(err => console.error(`    - Failed notification for team member ${memberId} on task ${task._id}:`, err)) // เพิ่ม catch error รายตัว
                                    );
                                }
                            });
                            taskIdsToUpdate.push(task._id); // เพิ่ม Task ID นี้เมื่อพบสมาชิกในทีม
                        } else {
                            console.warn(`    - Team ${task.team_id} for task ${task._id} found but has no members.`);
                        }
                    } catch (teamError) {
                        console.error(`    - Error fetching team ${task.team_id} for task ${task._id} reminder:`, teamError);
                    }
                } else {
                     console.warn(`  - Task ${task._id} has neither assignee nor team. Skipping reminder.`);
                }
            }

            // รอให้ Notification ทำงานเสร็จ (ไม่จำเป็นต้องรอผลลัพธ์ทั้งหมดถ้าไม่ต้องการ)
            // Promise.allSettled(notificationPromises);
            // console.log(`Attempted to create ${notificationPromises.length} reminder notifications.`);

            // อัปเดต Task ที่ *ควร* จะถูกส่งแจ้งเตือน (แม้ว่าการสร้าง notification อาจจะ fail)
            if (taskIdsToUpdate.length > 0) {
                const uniqueTaskIds = [...new Set(taskIdsToUpdate.map(id => id.toString()))]; // เอา ID ที่ไม่ซ้ำกัน
                try {
                     const updateResult = await Task.updateMany(
                        { _id: { $in: uniqueTaskIds.map(id => new mongoose.Types.ObjectId(id)) } },
                        { $set: { dueDateReminderSent: true } }
                    );
                    console.log(`Updated ${updateResult.modifiedCount} of ${uniqueTaskIds.length} tasks, setting dueDateReminderSent=true.`);
                } catch (updateError) {
                     console.error(`Error updating dueDateReminderSent flag:`, updateError);
                }
            }

        } catch (error) {
            console.error('Error during due date reminder check:', error);
        } finally {
             console.log(`[${new Date().toISOString()}] Finished due date reminder check.`);
        }
    }, {
        scheduled: true,
        timezone: "Asia/Bangkok" // ตรวจสอบ Timezone ให้ถูกต้อง
    });
    console.log('Due date reminder scheduler initialized (Schedule: Daily at 9:00 AM Bangkok time).');
}

module.exports = { scheduleDueDateChecks };
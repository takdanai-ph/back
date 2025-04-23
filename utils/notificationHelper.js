// utils/notificationHelper.js
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const Team = require('../models/Team'); // <<< มีอยู่แล้ว
const User = require('../models/User');   // <<< มีอยู่แล้ว

async function createNotification(userId, taskId, type, message, link = null) {

  // +++ DEBUG LOG +++
  // console.log('--- DEBUG: createNotification Received ---');
  // console.log('userId TYPE:', typeof userId);
  // console.log('userId VALUE:', userId);
  // console.log('taskId TYPE:', typeof taskId);
  // console.log('taskId VALUE:', taskId);
  // console.log('type:', type);
  // console.log('--------------------------------------');
  // +++ END DEBUG LOG +++

  try {

    let finalUserId = userId;
    // ตรวจสอบ ObjectId อย่างง่าย (อาจปรับปรุงให้ดีขึ้น)
    if (typeof userId === 'string' && mongoose.Types.ObjectId.isValid(userId)) {
         finalUserId = new mongoose.Types.ObjectId(userId);
    } else if (!(userId instanceof mongoose.Types.ObjectId)) {
        // ถ้าไม่ใช่ ObjectId และไม่ใช่ String ที่ Valid ให้ Log และไม่สร้าง Notification
         console.error(`--- ERROR: Invalid userId format for notification: ${userId} (Type: ${typeof userId})`);
         return; // ออกจากฟังก์ชัน ไม่สร้าง Notification
    }

    const newNotification = new Notification({
      user: finalUserId,
      task: taskId, // ควรตรวจสอบ taskId ด้วยว่าเป็น ObjectId ที่ถูกต้อง
      notification_type: type,
      message: message,
      link: link, // Optional link
      notification_status: 'unread'
    });

    await newNotification.save();
    console.log(`Notification created for user ${finalUserId}: ${type}`); // ใช้ finalUserId ใน log
    // เพิ่มเติม: อาจจะมีการ push notification แบบ Real-time ไปหา Client ด้วย Socket.IO ที่นี่

  } catch (error) {
    // Log error ที่ละเอียดขึ้น
    console.error(`Error creating notification for user ${userId} (Type: ${typeof userId}):`, error.message, error.stack);
  }
}

// --- เพิ่มฟังก์ชันนี้เข้ามา ---
/**
 * ค้นหา User ที่มี Role เป็น Admin หรือ Manager
 * @param {object} task - Task object (อาจไม่จำเป็นสำหรับ Logic นี้ แต่ใส่ไว้เผื่ออนาคต)
 * @returns {Promise<Array<string>|null>} - Promise ที่ resolve เป็น Array ของ User ID (String) หรือ null ถ้าไม่พบ/เกิด Error
 */
async function findRelevantAdminOrManager(task = null) { // รับ task เป็น optional
    try {
        // Logic ตัวอย่าง: ค้นหา User ทุกคนที่มี Role เป็น Admin หรือ Manager
        const adminsAndManagers = await User.find({ role: { $in: ['Admin', 'Manager'] } })
                                            .select('_id') // เลือกเฉพาะ field _id
                                            .lean(); // ใช้ .lean() เพื่อ performance ที่ดีขึ้น ถ้าไม่ต้องใช้ Mongoose methods ต่อ

        if (!adminsAndManagers || adminsAndManagers.length === 0) {
            console.warn(`[Notify Helper] No Admins or Managers found to notify.`);
            return []; // คืนค่าเป็น Array ว่าง
        }

        // คืนค่าเป็น Array ของ String ID
        return adminsAndManagers.map(user => user._id.toString());

    } catch (error) {
        console.error(`[Notify Helper] Error finding relevant admins/managers:`, error);
        return null; // คืนค่า null เมื่อเกิด Error
    }
}
// ----------------------------


// --- แก้ไข module.exports ให้รวมฟังก์ชันใหม่เข้าไปด้วย ---
module.exports = {
    createNotification,
    findRelevantAdminOrManager // <<< เพิ่มชื่อฟังก์ชันใหม่ที่นี่
};
// -------------------------------------------------------

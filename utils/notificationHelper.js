// utils/notificationHelper.js (ตัวอย่าง)
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const Team = require('../models/Team');
const User = require('../models/User');

async function createNotification(userId, taskId, type, message, link = null) {

  // +++ DEBUG LOG +++
  console.log('--- DEBUG: createNotification Received ---');
  console.log('userId TYPE:', typeof userId);
  console.log('userId VALUE:', userId);
  console.log('taskId TYPE:', typeof taskId);
  console.log('taskId VALUE:', taskId);
  console.log('type:', type);
  console.log('--------------------------------------');
  // +++ END DEBUG LOG +++

  try {

    let finalUserId = userId;
    if (!(userId instanceof mongoose.Types.ObjectId) && !mongoose.Types.ObjectId.isValid(userId)) {
         // ถ้าเป็น string ID ที่ถูกต้อง ก็แปลงได้
         // finalUserId = new mongoose.Types.ObjectId(userId);
         // แต่ Schema ควรจัดการเรื่องนี้ได้ ถ้ามันเป็น String ID ที่ถูกต้องจริงๆ
         console.warn(`--- WARNING: Received userId (${userId}) is not a valid ObjectId string format, proceeding anyway.`)
    }

    const newNotification = new Notification({
      user: finalUserId,
      task: taskId,
      notification_type: type,
      message: message,
      link: link, // Optional link
      notification_status: 'unread'
    });

    await newNotification.save();
    console.log(`Notification created for user ${userId}: ${type}`);
    // เพิ่มเติม: อาจจะมีการ push notification แบบ Real-time ไปหา Client ด้วย Socket.IO ที่นี่
    
  } catch (error) {
    console.error(`Error creating notification for user ${userId}:`, error);
  }
}

module.exports = { createNotification };
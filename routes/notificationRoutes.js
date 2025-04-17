// routes/notifications.js
const express = require('express');
const Notification = require('../models/Notification'); // Import Model
const { protect } = require('../middleware/authMiddleware'); // Import middleware ตรวจสอบ Login

const router = express.Router();

// --- GET /api/notifications - ดึง Notification ของผู้ใช้ปัจจุบัน ---
// สามารถเพิ่ม query param เช่น ?status=unread หรือ ?limit=10 ได้
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user.id; // user id ได้มาจาก middleware protect
    const { status, limit = 10, page = 1 } = req.query; // รับ query params

    const query = { user: userId };
    if (status && ['read', 'unread'].includes(status)) {
      query.notification_status = status;
    }

    const options = {
      sort: { createdAt: -1 }, // เรียงตามวันที่สร้างล่าสุดก่อน
      limit: parseInt(limit, 10),
      skip: (parseInt(page, 10) - 1) * parseInt(limit, 10),
      populate: { // ดึงข้อมูล Task ที่เกี่ยวข้องมาด้วย (ถ้าต้องการ)
        path: 'task',
        select: 'name description' // เลือก field ที่ต้องการจาก Task
      }
    };

    const notifications = await Notification.find(query, null, options);
    const totalNotifications = await Notification.countDocuments(query); // นับจำนวนทั้งหมด (สำหรับ pagination)

    res.json({
        notifications,
        currentPage: parseInt(page, 10),
        totalPages: Math.ceil(totalNotifications / parseInt(limit, 10)),
        totalCount: totalNotifications
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    res.status(500).json({ error: 'Server error fetching notifications' });
  }
});

// --- PATCH /api/notifications/:id/read - อัปเดตสถานะเป็น 'read' ---
router.patch('/:id/read', protect, async (req, res) => {
  try {
    const notificationId = req.params.id;
    const userId = req.user.id;

    const notification = await Notification.findById(notificationId);

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // *** สำคัญ: ตรวจสอบว่าเป็น Notification ของ User คนนี้จริงๆ ***
    // ต้องแปลง ObjectId เป็น String ก่อนเทียบ หรือใช้ .equals()
    if (!notification.user.equals(userId)) {
        return res.status(403).json({ error: 'User not authorized to update this notification' });
    }

    // ถ้ายังไม่ได้อ่าน ก็อัปเดตเป็นอ่านแล้ว
    if (notification.notification_status === 'unread') {
      notification.notification_status = 'read';
      await notification.save();
    }

    res.json(notification); // ส่ง notification ที่อัปเดตแล้วกลับไป
  } catch (error) {
    console.error("Mark Notification Read Error:", error);
    // ตรวจสอบว่าเป็น ObjectId ผิดรูปแบบหรือไม่
     if (error.name === 'CastError') {
        return res.status(400).json({ error: 'Invalid notification ID format' });
    }
    res.status(500).json({ error: 'Server error updating notification' });
  }
});

// --- (Optional) DELETE /api/notifications/:id - ลบ Notification ---
router.delete('/:id', protect, async (req, res) => {
  try {
      const notificationId = req.params.id;
      const userId = req.user.id;

      // --- ลองใช้ findByIdAndDelete ---
      // 1. ค้นหา Notification และตรวจสอบว่าเป็นของ User คนนี้ ก่อนที่จะลบ
      const notificationToDelete = await Notification.findOne({ _id: notificationId, user: userId });

      // 2. ตรวจสอบว่าเจอ Notification ที่ตรงเงื่อนไขหรือไม่
      if (!notificationToDelete) {
          // อาจจะหาไม่เจอ หรือเจอแต่ไม่ใช่ของ User คนนี้
          // ลองหาเฉพาะ ID ดูก่อนเพื่อแยกแยะ Error
          const exists = await Notification.findById(notificationId);
          if (!exists) {
               return res.status(404).json({ message: 'Notification not found' });
          } else {
              // ถ้าหาเจอแต่ User ID ไม่ตรง
               return res.status(403).json({ message: 'User not authorized to delete this notification' });
          }
      }

      // 3. ถ้าเจอและเป็นของ User คนนี้ ก็สั่งลบโดยตรงด้วย ID
      await Notification.findByIdAndDelete(notificationId);
      // --- สิ้นสุดการใช้ findByIdAndDelete ---

      // 4. ส่ง Response สำเร็จ
      res.status(200).json({ message: 'Notification deleted successfully' }); // ส่ง status 200 ด้วยก็ได้

  } catch (error) { // 5. จัดการ Error
      console.error("Delete Notification Error:", error);
      if (error.name === 'CastError') {
          return res.status(400).json({ message: 'Invalid notification ID format' });
      }
      res.status(500).json({ message: 'Server error deleting notification' }); // ส่ง message แทน error โดยตรง
  }
});

module.exports = router;
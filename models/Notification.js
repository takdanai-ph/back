const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({

  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  task: {type: mongoose.Schema.Types.ObjectId,ref: 'Task', required: true },
  notification_type: { type: String, required: true, 
    enum: [
        'task_assigned', 
        'task_updated', 
        'task_due_soon', 
        'task_overdue', 
        'comment_added', 
        'other'
    ],

  },
  notification_date: { type: Date, default: Date.now },
  notification_status: { type: String, required: true, enum: ['unread', 'read'], default: 'unread', index: true },
  message: { type: String, required: true },
  link: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Notification', NotificationSchema);
const mongoose = require("mongoose");

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    dueDate: { type: Date, required: true },
    status: { type: String, enum: ["Pending", "In Progress", "Completed"], default: "Pending" },
    tags: [{ type: String }],
    assignee_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, index: true },
    team_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: false, index: true },
    completedAt: { type: Date, required: false },
    dueDateReminderSent: { type: Boolean, default: false },
    overdueReminderSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

taskSchema.index({ status: 1, dueDate: 1, dueDateReminderSent: 1, overdueReminderSent: 1 });

const Task = mongoose.model("Task", taskSchema);

module.exports = Task;

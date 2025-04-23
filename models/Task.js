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
    needsCompletionApproval: { type: Boolean, default: false, index: true,},
  },
  { timestamps: true }
);

// taskSchema.index({ status: 1, dueDate: 1, dueDateReminderSent: 1, overdueReminderSent: 1 });
taskSchema.index({ status: 1, needsCompletionApproval: 1, dueDate: 1 });
taskSchema.index({ assignee_id: 1, status: 1, needsCompletionApproval: 1 });
taskSchema.index({ team_id: 1, status: 1, needsCompletionApproval: 1 });

const Task = mongoose.model("Task", taskSchema);

module.exports = Task;

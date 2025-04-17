const mongoose = require('mongoose');

const TeamTaskSchema = new mongoose.Schema({
  team_id: { type: Number, ref: 'Team', required: true },
  task_id: { type: Number, ref: 'Task', required: true },
});

TeamTaskSchema.index({ team_id: 1, task_id: 1 }, { unique: true }); // ป้องกันความสัมพันธ์ซ้ำ

module.exports = mongoose.model('Team_Task', TeamTaskSchema);
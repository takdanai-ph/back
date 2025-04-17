const mongoose = require("mongoose");

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true,unique: true },
    description: String,
    leader_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: false, default: null },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  },
  { timestamps: true }
);
  
  const Team = mongoose.model('Team', teamSchema);

  module.exports = Team;
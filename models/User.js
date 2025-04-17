const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true }, 
  password: { type: String, required: true }, // hash ก่อนบันทึก
  role: { type: String, enum: ['Admin', 'Manager', 'User'], default: 'User' },
  team_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: false },
  fname: { type: String, required: true },
  lname: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  picture: { type: String, default: 'default.png' }, // URL รูปโปรไฟล์
  resetPasswordToken: String,
  resetPasswordExpire: Date
}, { timestamps: true });

// ทำการ Hash รหัสผ่านก่อนบันทึก
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

module.exports = mongoose.model('User', UserSchema);
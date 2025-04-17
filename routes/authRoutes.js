const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const sendEmail = require('../utils/sendEmail');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/authMiddleware');
const router = express.Router();

// add user
// router.post('/register', async (req, res) => {
//   const { username, password, fname, lname, email, role } = req.body;
//   try {
//     const user = await User.create({ username, password, fname, lname, email, role });
//     res.status(201).json({ message: 'User registered successfully' });
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });

////////////////////////////////////// login //////////////////////////////////////
// router.post('/login', async (req, res) => {
//   const { username, password } = req.body;
//   try {
//     const user = await User.findOne({ username });
//     if (!user) return res.status(401).json({ message: 'Invalid credentials' });

//     const isMatch = await bcrypt.compare(password, user.password);
//     if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

//     // สร้าง JWT Token
//     const token = jwt.sign({ id: user._id, username: user.username, role: user.role, team_id: user.team_id }, process.env.JWT_SECRET, { expiresIn: '1h' });

//     res.json({ token, user: { id: user._id, username: user.username, role: user.role, team_id: user.team_id } });
//   } catch (error) {
//     res.status(500).json({ error: error.message });
//   }
// });

////////////////////////////////////// login 2 //////////////////////////////////////

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  // ตรวจสอบว่ามีการส่ง username และ password มาหรือไม่
  if (!username || !password) {
    return res.status(400).json({
      status: "error",
      message: "Missing username and/or password"
    });
  }
  
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({
        status: "error",
        message: "Login failed"
      });
    }
    
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        status: "error",
        message: "Login failed"
      });
    }
    
    // สร้าง Token ตั้งเวลาให้หมดอายุ
    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role, team_id: user.team_id },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );
    
    // ส่ง Response 200 พร้อมข้อมูลที่ต้องการ
    res.status(200).json({
      status: "ok",
      message: "Logged in",
      accessToken: token,
      expiresIn: 86400000, // 60,000 มิลลิวินาที = 60 วินาที
      user: {
        id: user._id,
        fname: user.fname,
        lname: user.lname,
        username: user.username,
        email: user.email,
        picture: user.picture,
        role : user.role
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

////////////////////////////////////// ดู all user //////////////////////////////////////
// router.get('/users', protect, authorize(['Admin']), async (req, res) => {
//     try {
//       const users = await User.find().select('-password'); // ไม่ส่งคืนรหัสผ่าน
//       res.json(users);
//     } catch (error) {
//       res.status(500).json({ error: error.message });
//     }
//   });  

////////////////////////////////////// ดู User (ทั้งหมด หรือ กรองตามเงื่อนไข) //////////////////////////////////////

router.get('/users', protect, authorize(['Admin', 'Manager', 'User']), async (req, res) => { // <<< เปลี่ยน authorize ให้ Manager เข้าถึงได้ด้วย
  try {
    const { assignment } = req.query; // ดึงค่า query parameter 'assignment'

    let filter = {}; // สร้าง object filter เริ่มต้น (ค่าว่าง = ไม่กรอง)

    // --- ตรวจสอบเงื่อนไข Query Parameter ---
    if (assignment === 'unassigned') {
      // ถ้าต้องการหาคนที่ยังไม่มีทีม ให้สร้าง filter สำหรับค้นหา user ที่ team_id เป็น null หรือ ไม่มี field นี้เลย
      filter = { team_id: { $in: [null, undefined] } };
    }
    // สามารถเพิ่มเงื่อนไข else if อื่นๆ ได้ในอนาคต เช่น ?role=User

    // --- ค้นหา User ตาม filter ที่กำหนด ---
    // และเลือก field ที่ต้องการ ไม่เอา password
    const users = await User.find(filter).select('-password -resetPasswordToken -resetPasswordExpire'); // <<< เลือก field เพิ่มเติมที่ไม่ต้องการ

    res.json(users); // ส่งผลลัพธ์กลับไป

  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: 'An error occurred while fetching users.' });
  }
});

////////////////////////////////////// create user //////////////////////////////////////
router.post("/users", protect, authorize(["Admin", "Manager"]), async (req, res) => {
  const { username, password, role, fname, lname, email, team_id } = req.body;
  try {
    // const user = await User.create({ username, password, role, fname, lname, email });
    // res.status(201).json(user);
     // เพิ่ม team_id ถ้ามีการส่งมา
     const userData = { username, password, role, fname, lname, email };
     if (team_id) {
       userData.team_id = team_id;
     }
     const user = await User.create(userData);
     res.status(201).json(user);
  } catch (error) {
    // res.status(500).json({ error: error.message });
    console.error("Create user error:", error);
    // เพิ่ม error handling
     if (error.name === 'ValidationError') {
         return res.status(400).json({ error: error.message });
     }
     if (error.code === 11000) { // Duplicate key error (username or email)
         return res.status(400).json({ error: 'Username or email already exists.' });
     }
    res.status(500).json({ error: "An error occurred while creating the user." });
  }
});

////////////////////////////////////// edit user //////////////////////////////////////
router.put("/users/:id", protect, authorize(["Admin", "Manager"]), async (req, res) => {
  const { fname, lname, email, role, team_id } = req.body;
  try {
    // const updatedUser = await User.findByIdAndUpdate(req.params.id, { fname, lname, email, role }, { new: true });
    // res.json(updatedUser);
    const updateData = { fname, lname, email, role };
     if (team_id !== undefined) { // เช็คว่ามีการส่ง team_id มาหรือไม่ (อาจจะส่ง null มาเพื่อลบ)
        updateData.team_id = team_id ? team_id : null; // กำหนดเป็น null ถ้าค่าที่ส่งมาเป็น falsy (เช่น "", null)
     }

    // const updatedUser = await User.findByIdAndUpdate(req.params.id, { fname, lname, email, role, team_id }, { new: true });
     const updatedUser = await User.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true }); // เพิ่ม runValidators

     if (!updatedUser) { // เพิ่มการตรวจสอบว่าหา user เจอหรือไม่
         return res.status(404).json({ message: "User not found" });
     }
    res.json(updatedUser);
  } catch (error) {
    // res.status(500).json({ error: error.message });
    console.error("Update user error:", error); // Log error เพิ่มเติม
     // เพิ่มการจัดการ error ที่เฉพาะเจาะจงมากขึ้น เช่น validation error
     if (error.name === 'ValidationError') {
         return res.status(400).json({ error: error.message });
     }
     if (error.name === 'CastError' && error.path === '_id') {
        return res.status(400).json({ error: 'Invalid user ID format' });
     }
     if (error.name === 'CastError' && error.path === 'team_id') {
        return res.status(400).json({ error: 'Invalid team ID format' });
     }
    res.status(500).json({ error: "An error occurred while updating the user." });
  }
});

////////////////////////////////////// del user //////////////////////////////////////
router.delete("/users/:id", protect, authorize(["Admin"]), async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: "User deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

////////////////////////////////////// find fname user //////////////////////////////////////
router.get("/users/:fname", protect, authorize(["Admin"]), async (req, res) => {
    try {
        const fname = await User.find({
            fname: { $regex: req.params.fname, $options: "i" }
        });

        if (fname.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json(fname);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

////////////////////////////////////////////////////////////////////////////

// --- Endpoint ขอ Reset Password ---
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ status: "error", message: "Please provide an email" });
  }

  try {
    const user = await User.findOne({ email });

    // สำคัญ: ไม่ว่าเจอ Email หรือไม่เจอ ให้ตอบกลับเหมือนกันเพื่อความปลอดภัย
    if (!user) {
      console.log(`Forgot password attempt for non-existent email: ${email}`);
      // เราไม่บอก client ว่า email ไม่มีอยู่จริง
      return res.status(200).json({ status: "ok", message: "If an account with that email exists, a password reset link has been sent." });
    }

    // 1. สร้าง Reset Token ดิบ (Raw Token)
    const resetToken = crypto.randomBytes(20).toString('hex');

    // 2. Hash Token ก่อนเก็บลง DB (เพิ่มความปลอดภัย)
    const hashedToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');

    // 3. กำหนดเวลาหมดอายุ (เช่น 15 นาทีจากตอนนี้)
    const expireMinutes = parseInt(process.env.RESET_PASSWORD_EXPIRE_MINUTES || '15', 10);
    const resetExpire = Date.now() + expireMinutes * 60 * 1000; // เวลาหมดอายุในหน่วย ms

    // 4. บันทึก hashedToken และ expire time ลง User document
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpire = new Date(resetExpire); // เก็บเป็น Date object
    await user.save();

    // 5. สร้าง Reset URL สำหรับใส่ใน Email
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`; // ใช้ Raw Token ใน URL

    // 6. สร้างข้อความ Email
    const message = `
      คุณได้รับอีเมลนี้เนื่องจากมีการร้องขอรีเซ็ตรหัสผ่านสำหรับบัญชีของคุณ (${user.username})
      กรุณาคลิกที่ลิงก์ต่อไปนี้ หรือคัดลอกไปวางในเบราว์เซอร์เพื่อตั้งรหัสผ่านใหม่:
      \n\n
      ${resetUrl}
      \n\n
      ลิงก์นี้จะหมดอายุใน ${expireMinutes} นาที
      \n\n
      หากคุณไม่ได้เป็นผู้ร้องขอ กรุณาเพิกเฉยต่ออีเมลนี้ รหัสผ่านของคุณจะยังคงปลอดภัย
    `;

    // 7. ส่ง Email
    const emailSent = await sendEmail({
      email: user.email,
      subject: 'Password Reset Request',
      message: message,
    });

    if (emailSent) {
        // ตอบกลับแบบกลางๆ เสมอ
         res.status(200).json({ status: "ok", message: "If an account with that email exists, a password reset link has been sent." });
    } else {
        // ถ้าส่ง Email ไม่สำเร็จ อาจจะต้องเคลียร์ Token ที่เพิ่งสร้างไป
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();
        res.status(500).json({ status: "error", message: "Error sending email" });
    }

  } catch (error) {
    console.error("Forgot Password Error:", error);
    // อาจจะต้องเคลียร์ Token ถ้าเกิด Error ระหว่าง save
    // ไม่จำเป็นต้องแจ้ง Client อย่างละเอียด อาจจะส่งแค่ Internal Error
    res.status(500).json({ status: "error", message: "Server error processing request" });
  }
});

// --- Endpoint ตั้งรหัสผ่านใหม่ ---
router.post('/reset-password', async (req, res) => {
    const { token, password } = req.body;

    if (!token || !password) {
        return res.status(400).json({ status: "error", message: "Missing token or new password" });
    }

    try {
        // 1. Hash Token ที่ได้รับจาก Client เพื่อนำไปค้นหาใน DB
        const hashedToken = crypto
            .createHash('sha256')
            .update(token) // Hash Raw Token ที่ได้จาก body
            .digest('hex');

        // 2. ค้นหา User ด้วย Hashed Token และเช็คว่ายังไม่หมดอายุ
        const user = await User.findOne({
            resetPasswordToken: hashedToken,
            resetPasswordExpire: { $gt: Date.now() } // เช็คว่าเวลายังไม่เกินปัจจุบัน
        });

        if (!user) {
            return res.status(400).json({ status: "error", message: "Invalid or expired token" });
        }

        // 3. ถ้าเจอ User และ Token ถูกต้อง -> ตั้งรหัสผ่านใหม่
        // ทำการ Hash รหัสผ่านใหม่ (User model ควรมี pre-save hook จัดการ hash อยู่แล้ว หรือ hash ตรงนี้)
        // ถ้า User model ไม่ได้ hash อัตโนมัติ:
        // const salt = await bcrypt.genSalt(10);
        // user.password = await bcrypt.hash(password, salt);
        user.password = password; // สมมติว่า pre-save hook ใน User model จะ hash ให้

        // 4. ล้างค่า Reset Token และวันหมดอายุ
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save(); // บันทึกการเปลี่ยนแปลง (password ควรจะถูก hash โดย pre-save hook)

        // 5. ส่ง Response แจ้งสำเร็จ
        res.status(200).json({ status: "ok", message: "Password reset successful" });

    } catch (error) {
        console.error("Reset Password Error:", error);
        res.status(500).json({ status: "error", message: "Server error resetting password" });
    }
});

// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// <<< เพิ่ม Route ใหม่สำหรับดึงข้อมูล User ปัจจุบัน >>>
// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  // Middleware `protect` จะตรวจสอบ Token และแนบข้อมูล user (id, role etc. จาก token payload) มาใน req.user
  try {
      // ใช้ ID จาก req.user (ที่ได้จาก Token) เพื่อความปลอดภัย
      // ค้นหา User จาก Database เพื่อให้ได้ข้อมูลล่าสุด และเลือกเฉพาะ field ที่ต้องการ
      const user = await User.findById(req.user.id)
                           .select('-password -resetPasswordToken -resetPasswordExpire -__v') // ไม่เอา fields ที่ไม่ต้องการ/ละเอียดอ่อน
                           // .populate('team_id', 'name'); // <<< Optional: ถ้าต้องการชื่อทีมด้วย ณ จุดนี้เลย (แต่ YourTeam เรียกแยกอยู่แล้ว อาจจะไม่ต้อง)

      if (!user) {
          // กรณีนี้ไม่น่าเกิดถ้า Token ถูกต้อง แต่ใส่ไว้เผื่อ
          return res.status(404).json({ message: 'User not found.' });
      }

      // ส่งข้อมูล User กลับไปให้ Frontend
      res.status(200).json(user);

  } catch (error) {
      console.error("Get Me Error:", error);
      res.status(500).json({ message: 'Server error fetching user data.' });
  }
});
// ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

module.exports = router;
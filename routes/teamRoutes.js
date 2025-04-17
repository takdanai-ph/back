// clone/back/routes/teamRoutes.js

const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

const Team = require('../models/Team');
const User = require('../models/User'); // <<< ตรวจสอบว่า Import User Model ถูกต้อง
const { protect, authorize } = require('../middleware/authMiddleware'); // <<< ตรวจสอบว่า Import ถูกต้อง

// --- สร้าง Team (จำกัดสิทธิ์ Admin/Manager) ---
router.post('/', protect, authorize(['Admin', 'Manager']), async (req, res) => {
  try {
    // เพิ่มการ Trim ข้อมูล Input (Optional but recommended)
    const name = req.body.name ? req.body.name.trim() : undefined;
    const description = req.body.description ? req.body.description.trim() : undefined;

    if (!name) {
        return res.status(400).json({ error: 'Team name is required.' });
    }

    const team = new Team({ name, description }); // ส่งข้อมูลที่ Trim แล้ว
    await team.save();
    res.status(201).json(team);
  } catch (error) {
    if (error.name === 'ValidationError') {
        // ข้อความ Error จาก Mongoose อาจจะเพียงพอ
        return res.status(400).json({ error: error.message });
    }
    if (error.code === 11000) { // Duplicate key (name)
        return res.status(400).json({ error: 'Team name already exists.' });
    }
    console.error("Create team error:", error);
    res.status(500).json({ error: "An error occurred while creating the team." });
  }
});

// --- อ่าน Team ทั้งหมด (จำกัดสิทธิ์ Login) ---
// อาจจะพิจารณาว่า Role 'User' ควรเห็นรายชื่อทีมทั้งหมดหรือไม่?
// ถ้าไม่ควรเห็นทั้งหมด อาจจะต้องเพิ่ม authorize หรือ Filter ใน Logic
router.get('/', protect, async (req, res) => {
  try {
    const teams = await Team.find()
      .populate('leader_id', 'fname lname email username')
      .sort({ name: 1 }); // เรียงตามชื่อ
    res.json(teams);
  } catch (error) {
    console.error("Get all teams error:", error);
    res.status(500).json({ error: "An error occurred while fetching teams." });
  }
});

// --- อ่าน Team ด้วย ID (ปรับปรุงสิทธิ์) ---
// อนุญาตให้ Admin/Manager หรือสมาชิกในทีมนั้นดูได้
router.get('/:id', protect, async (req, res) => {
  try {
    const requestedTeamId = req.params.id;
    const userRole = req.user.role;
    const userTeamId = req.user.team_id; // Team ID ของผู้ใช้ที่ Login อยู่ (จาก Token)
    // const userId = req.user.id; // อาจจะได้ใช้ถ้าเช็ค Leader

    let canView = false;

    // 1. ตรวจสอบว่าเป็น Admin หรือ Manager หรือไม่?
    if (userRole === 'Admin' || userRole === 'Manager') {
      canView = true;
    }
    // 2. ถ้าไม่ใช่ Admin/Manager, ตรวจสอบว่าเป็นทีมของ User เองหรือไม่?
    else if (userTeamId && userTeamId.toString() === requestedTeamId) {
       canView = true;
    }
    // (Optional: เพิ่มเงื่อนไขให้ Leader ดูได้)

    // --- ถ้าไม่มีสิทธิ์ดู ให้ trả về 403 ---
    if (!canView) {
        return res.status(403).json({ message: 'Forbidden: You do not have permission to view this team\'s details.' });
    }

    // --- ถ้ามีสิทธิ์ดู ให้ดึงข้อมูลทีม ---
    const team = await Team.findById(requestedTeamId)
      .populate('leader_id', 'fname lname email username'); // Populate เหมือนเดิม

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }
    res.json(team); // ส่งข้อมูลทีมกลับไป

  } catch (error) {
     if (error.name === 'CastError') { return res.status(400).json({ error: 'Invalid team ID format' }); }
    console.error("Get team by id error:", error);
    res.status(500).json({ error: "An error occurred while fetching the team." });
  }
});

// --- อ่าน Team ด้วยชื่อ (อาจจะไม่จำเป็นต้องมี ถ้า Frontend ไม่ได้ใช้) ---
// router.get('/name/:name', async (req, res) => { ... });

// --- แก้ไข Team (จำกัดสิทธิ์ Admin/Manager) ---
router.put('/:id', protect, authorize(['Admin', 'Manager']), async (req, res) => {
  try {
     const { name, description } = req.body;
     // Validate input (Ensure name is not empty after trimming)
     const trimmedName = name ? name.trim() : undefined;
     const trimmedDescription = description !== undefined ? description.trim() : undefined; // Allow empty description

     if (trimmedName === '') { // Check if name becomes empty after trim
         return res.status(400).json({ error: 'Team name cannot be empty.' });
     }

     const updateData = {};
     if (trimmedName !== undefined) updateData.name = trimmedName;
     if (trimmedDescription !== undefined) updateData.description = trimmedDescription;


     if (Object.keys(updateData).length === 0) {
         return res.status(400).json({ error: 'No valid fields provided for update.' });
     }

    const team = await Team.findByIdAndUpdate(req.params.id, updateData, {
      new: true, // คืนค่า document ที่ update แล้ว
      runValidators: true, // ให้ run validation ของ schema ตอน update
      context: 'query' // จำเป็นสำหรับบาง validation เช่น unique
    }).populate('leader_id', 'fname lname email username');

    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }
    res.json(team);
  } catch (error) {
     if (error.name === 'ValidationError') { return res.status(400).json({ error: error.message }); }
      if (error.code === 11000) { return res.status(400).json({ error: 'Team name already exists.' }); }
     if (error.name === 'CastError') { return res.status(400).json({ error: 'Invalid team ID format' }); }
    console.error("Update team error:", error);
    res.status(500).json({ error: "An error occurred while updating the team." });
  }
});

// --- ลบ Team (จำกัดสิทธิ์ Admin/Manager) ---
router.delete('/:id', protect, authorize(['Admin', 'Manager']), async (req, res) => {
  try {
    const teamId = req.params.id;
    const team = await Team.findByIdAndDelete(teamId);
    if (!team) {
      return res.status(404).json({ message: 'Team not found' });
    }
    // อัปเดต User ที่เคยอยู่ในทีมนี้ ให้ team_id เป็น null
    await User.updateMany({ team_id: teamId }, { $set: { team_id: null } });

    // (ถ้าใช้ Team_Task junction table: await Team_Task.deleteMany({ team_id: teamId });)

    res.json({ message: `Team "${team.name}" deleted successfully and members unassigned.` });
  } catch (error)
  {
     if (error.name === 'CastError') { return res.status(400).json({ error: 'Invalid team ID format' }); }
    console.error("Delete team error:", error);
    res.status(500).json({ error: "An error occurred while deleting the team." });
  }
});

// --- GET Members ของ Team (ปรับปรุงสิทธิ์) ---
// อนุญาตให้ Admin/Manager หรือสมาชิกในทีมนั้นดูได้
router.get('/:teamId/members', protect, async (req, res) => {
   try {
    const requestedTeamId = req.params.teamId;
    const userRole = req.user.role;
    const userTeamId = req.user.team_id;
    // const userId = req.user.id;

    let canViewMembers = false;

    // 1. Admin/Manager ดูได้เสมอ
    if (userRole === 'Admin' || userRole === 'Manager') {
        canViewMembers = true;
    }
    // 2. สมาชิกในทีม เห็นสมาชิกคนอื่นได้
    else if (userTeamId && userTeamId.toString() === requestedTeamId) {
        canViewMembers = true;
    }
    // (Optional: เพิ่มเงื่อนไขให้ Leader ดูได้)

    // --- ถ้าไม่มีสิทธิ์ดู ให้ trả về 403 ---
    if (!canViewMembers) {
        return res.status(403).json({ message: 'Forbidden: You do not have permission to view these team members.' });
    }

    // ตรวจสอบว่า Team มีอยู่จริง (ป้องกันการยิง ID มั่วๆ)
    // ใช้ .countDocuments หรือ .exists() เพื่อประสิทธิภาพที่ดีกว่าการดึงข้อมูลเต็มๆ
    const teamExists = await Team.exists({ _id: requestedTeamId });
    if (!teamExists) return res.status(404).json({ message: 'Team not found' });

    // --- ถ้ามีสิทธิ์ ให้ดึงข้อมูล Members ---
    const members = await User.find({ team_id: requestedTeamId })
                            .select('fname lname email username role _id') // เลือก field ที่ต้องการ
                            .sort({ fname: 1, lname: 1 }); // เรียงตามชื่อ

    res.json(members);

  } catch (error) {
     if (error.name === 'CastError') { return res.status(400).json({ error: 'Invalid team ID format' }); }
    console.error("Get team members error:", error);
    res.status(500).json({ error: 'An error occurred while fetching team members.' });
  }
});


// --- PUT Set/Change Team Leader (จำกัดสิทธิ์ Admin/Manager) ---
router.put('/:teamId/leader', protect, authorize(['Admin', 'Manager']), async (req, res) => {
  try {
    const { teamId } = req.params;
    const { leaderId } = req.body; // รับ ID ของ User ที่จะเป็น Leader ใหม่ (หรือ null/undefined/"" เพื่อลบ)

    const team = await Team.findById(teamId);
    if (!team) { return res.status(404).json({ message: 'Team not found' }); }

    if (leaderId) {
      const potentialLeader = await User.findById(leaderId);
      if (!potentialLeader) { return res.status(404).json({ message: 'Potential leader (User) not found' }); }
      // *** สำคัญ: ตรวจสอบว่า User คนนั้นเป็นสมาชิกของทีมนี้หรือไม่ ***
      if (!potentialLeader.team_id || !potentialLeader.team_id.equals(teamId)) {
         return res.status(400).json({ message: 'Cannot assign a user who is not a member of this team as leader.' });
      }
      team.leader_id = potentialLeader._id;
    } else {
      // ถ้าส่ง leaderId มาเป็น null/empty string ให้ลบ Leader
      team.leader_id = null;
    }

    await team.save();
    const updatedTeam = await Team.findById(teamId)
                                  .populate('leader_id', 'fname lname email username');
    res.json(updatedTeam);

  } catch (error) {
     if (error.name === 'CastError') { // ดักจับ ID Format ผิด (ทั้ง teamId และ leaderId)
        return res.status(400).json({ error: `Invalid ${error.path === '_id' ? 'team' : 'leader'} ID format` });
    }
     if (error.name === 'ValidationError') { return res.status(400).json({ error: error.message }); }
    console.error("Set team leader error:", error);
    res.status(500).json({ error: 'An error occurred while updating the team leader.' });
  }
});

// --- POST Add a user to a team (จำกัดสิทธิ์ Admin/Manager) ---
router.post('/:teamId/members', protect, authorize(['Admin', 'Manager']), async (req, res) => {
  try {
      const { teamId } = req.params;
      const { userId } = req.body;

      if (!userId) {
          return res.status(400).json({ message: 'User ID is required.' });
      }
      if (!mongoose.Types.ObjectId.isValid(teamId)) {
           return res.status(400).json({ message: 'Invalid Team ID format.' });
      }
       if (!mongoose.Types.ObjectId.isValid(userId)) {
           return res.status(400).json({ message: 'Invalid User ID format.' });
      }


      // ใช้ Promise.all เพื่อหาข้อมูล Team และ User พร้อมกัน
      const [team, user] = await Promise.all([
          Team.findById(teamId),
          User.findById(userId)
      ]);

      // ตรวจสอบว่าหา Team และ User เจอหรือไม่
      if (!team) { return res.status(404).json({ message: 'Team not found' }); }
      if (!user) { return res.status(404).json({ message: 'User not found' }); }

      // เช็คว่า User อยู่ทีมอื่นแล้วหรือยัง (ตาม Logic เดิมของคุณที่ User อยู่ได้ทีมเดียว)
      if (user.team_id && !user.team_id.equals(teamId)) {
          // ค้นหาชื่อทีมเดิมเพื่อแสดงในข้อความ Error (Optional)
          const existingTeam = await Team.findById(user.team_id).select('name');
          const existingTeamName = existingTeam ? `"${existingTeam.name}"` : 'another team';
          return res.status(400).json({ message: `User "${user.username}" is already assigned to ${existingTeamName}.` });
      }

      // ตรวจสอบว่า User เป็นสมาชิกของทีมนี้อยู่แล้วหรือไม่
      // วิธีที่ 1: เช็คจาก user.team_id
      // if (user.team_id && user.team_id.equals(teamId)) {
      // วิธีที่ 2: เช็คจาก team.members (อาจจะแม่นยำกว่าถ้า Logic ซับซ้อน)
      const isAlreadyMember = team.members.some(memberId => memberId.equals(userId));

      if (isAlreadyMember && user.team_id && user.team_id.equals(teamId)) {
           console.log(`User ${user.username} is already a confirmed member of team ${team.name}.`);
           return res.status(200).json({ message: `User "${user.username}" is already a member of team "${team.name}".` });
      }


      // --- ทำการอัปเดตทั้ง Team และ User ---
      // ใช้ $addToSet เพื่อเพิ่ม userId เข้า members array (ป้องกันการซ้ำ)
      // ใช้ $set เพื่อกำหนด team_id ให้ User
      console.log(`Adding user ${userId} to team ${teamId} members array and setting user's team_id...`);
      const [teamUpdateResult, userUpdateResult] = await Promise.all([
           Team.updateOne({ _id: teamId }, { $addToSet: { members: userId } }), // <-- เพิ่ม User เข้า members array ของ Team
           User.updateOne({ _id: userId }, { $set: { team_id: teamId } })      // <-- กำหนด team_id ให้ User
      ]);
      console.log('Team update result:', teamUpdateResult);
      console.log('User update result:', userUpdateResult);
      // ------------------------------------


      // ส่ง Response สำเร็จ
      // ดึงข้อมูล User ล่าสุดมาแสดง (Optional)
      // const updatedUser = await User.findById(userId).select('username team_id');
      res.status(200).json({ message: `User "${user.username}" successfully added to team "${team.name}".`}); // ส่งข้อความยืนยัน

  } catch (error) {
      // Error handling อื่นๆ
      // if (error.name === 'CastError') { return res.status(400).json({ error: `Invalid ${error.path === '_id' ? 'ID' : error.path} format` }); } // Covered by validation above
      if (error.name === 'ValidationError') { return res.status(400).json({ error: error.message }); }
      console.error("Add team member error:", error);
      res.status(500).json({ error: 'An error occurred while adding the user to the team.' });
  }
});

// --- DELETE Remove a user from a team (จำกัดสิทธิ์ Admin/Manager) ---
router.delete('/:teamId/members/:userId', protect, authorize(['Admin', 'Manager']), async (req, res) => {
  try {
    const { teamId, userId } = req.params;

    const user = await User.findById(userId);
    if (!user) { return res.status(404).json({ message: 'User not found' }); }

    // เช็ค teamId format ไปด้วยเลย (ใช้ exists หรือ findById ก็ได้)
    const teamExists = await Team.exists({ _id: teamId });
    if (!teamExists) { return res.status(404).json({ message: 'Team specified in URL not found' }); }

    if (!user.team_id || !user.team_id.equals(teamId)) {
      return res.status(400).json({ message: `User is not currently a member of team ${teamId}.` });
    }

    const previousTeamId = user.team_id; // เก็บไว้ก่อน Clear
    user.team_id = null; // ลบ User ออกจากทีม
    let unsetLeaderMessage = ''; // ข้อความเพิ่มเติมถ้า User เป็น Leader

    // ตรวจสอบว่า User เป็น Leader ของทีมนั้นหรือไม่ ก่อน Save การเปลี่ยนแปลงของ User
    const team = await Team.findById(previousTeamId); // ดึงทีมมาเช็ค Leader
    if (team && team.leader_id && team.leader_id.equals(userId)) {
        team.leader_id = null;
        await team.save(); // อัปเดต Leader ของทีมเป็น null
        unsetLeaderMessage = ' Team leadership position is now vacant.';
        console.log(`Unset leader for team ${team.name}.`);
    }

    await user.save(); // บันทึก User ที่ไม่มี team_id แล้ว

    res.status(200).json({ message: `User ${user.username} removed from team.${unsetLeaderMessage}` });

  } catch (error) {
     if (error.name === 'CastError') { return res.status(400).json({ error: `Invalid ${error.path === '_id' ? 'ID' : error.path} format` }); }
     if (error.name === 'ValidationError') { return res.status(400).json({ error: error.message }); }
    console.error("Remove team member error:", error);
    res.status(500).json({ error: 'An error occurred while removing the user from the team.' });
  }
});


module.exports = router;
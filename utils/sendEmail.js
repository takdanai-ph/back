const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
  // 1. สร้าง Transporter (ตั้งค่าการเชื่อมต่อ SMTP)
  // *** ใช้ Environment Variables ที่ตั้งไว้ ***
  const transporter = nodemailer.createTransport({
    host: process.env.NODE_MAILER_HOST,
    port: parseInt(process.env.NODE_MAILER_PORT || '587', 10), // ใช้ port 587 หรือ 465
    secure: parseInt(process.env.NODE_MAILER_PORT || '587', 10) === 465, // true for 465, false for other ports
    auth: {
      user: process.env.NODE_MAILER_EMAIL,
      pass: process.env.NODE_MAILER_PASSWORD,
    },
    // เพิ่มเติม: สำหรับ Gmail อาจจะต้องตั้งค่า less secure apps หรือ App Password
    // เพิ่มเติม: สำหรับ production ควรใช้ service เช่น SendGrid, Mailgun
  });

  // 2. กำหนด Email options
  const message = {
    from: `${process.env.EMAIL_FROM_NAME || 'Task Management'} <${process.env.NODE_MAILER_EMAIL}>`, // ชื่อผู้ส่ง <email ผู้ส่ง>
    to: options.email, // Email ผู้รับ
    subject: options.subject, // หัวข้อ Email
    text: options.message, // เนื้อหาแบบ Text ธรรมดา
    // html: options.html // หรือจะส่งเป็น HTML ก็ได้
  };

  // 3. ส่ง Email
  try {
    const info = await transporter.sendMail(message);
    console.log('Message sent: %s', info.messageId);
    return true;
  } catch (error) {
    console.error('Error sending email:', error);
    return false;
  }
};

module.exports = sendEmail;
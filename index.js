const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
require("dotenv").config();
const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const userRoutes = require("./routes/userRoutes");
const batchRoutes = require("./routes/batchRoutes");
const studentGroupRoutes = require("./routes/studentGroupRoutes");
const teacherRoutes = require("./routes/teacherRoutes");
const studentRoutes = require("./routes/studentRoutes");
const leadRoutes = require("./routes/leadRoutes");
const telecallerRoutes = require("./routes/telecallerRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const messageRoutes = require("./routes/messageRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const youtubeRoutes = require("./routes/youtubeRoutes");
const instituteRoutes = require("./routes/instituteRoutes");
const portfolioRoutes = require("./routes/portfolioRoutes");
const User = require("./models/User");
const { runPaymentCycleCheck } = require("./utils/paymentCycle");

const app = express();
const PORT = process.env.PORT || 5000;

connectDB();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
  res.json({ message: "Backend is running" });
});

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/batches", batchRoutes);
app.use("/api/student-groups", studentGroupRoutes);
app.use("/api/teacher", teacherRoutes);
app.use("/api/student", studentRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/telecaller", telecallerRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/admin/youtube", youtubeRoutes);
app.use("/api/institutes", instituteRoutes);
app.use("/api/portfolio", portfolioRoutes);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Deactivates students whose payment cycle lapsed unpaid, and rolls forward
// the cycle for anyone caught up. Runs on boot, then every 15 minutes.
const runCycleJob = () => {
  runPaymentCycleCheck(User)
    .then(({ deactivated, rolledOver, checked }) => {
      if (deactivated || rolledOver) {
        console.log(
          `[payment-cycle] checked ${checked}, deactivated ${deactivated}, rolled over ${rolledOver}`
        );
      }
    })
    .catch((err) => console.error("[payment-cycle] job failed:", err.message));
};
setInterval(runCycleJob, 15 * 60 * 1000);
setTimeout(runCycleJob, 5000);

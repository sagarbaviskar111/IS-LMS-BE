// A student's recording block covers a session date when recordingBlockFrom
// is set and the date falls on/after it, and on/before recordingBlockTo when
// that's set too. Leaving recordingBlockTo empty blocks that date and every
// date after it — used once a student's paid period lapses, until the admin
// clears the block after payment.
const isRecordingBlocked = (user, sessionDate) => {
  if (!user.recordingBlockFrom || !sessionDate) return false;
  const date = new Date(sessionDate);
  if (date < user.recordingBlockFrom) return false;
  if (user.recordingBlockTo && date > user.recordingBlockTo) return false;
  return true;
};

module.exports = { isRecordingBlocked };

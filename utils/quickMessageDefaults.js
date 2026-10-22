// Starter quick messages every telecaller sees until they change their list.
// {name} / {caller} / {institute} are filled in per lead on the frontend.
module.exports = [
  {
    label: "Introduction",
    text: "Hi {name}, this is {caller} from {institute}. Thanks for your interest! When would be a good time to talk about the course?",
  },
  {
    label: "Missed call",
    text: "Hi {name}, I tried calling you from {institute} but couldn't reach you. Please let me know a good time to call back.",
  },
  {
    label: "Follow-up",
    text: "Hi {name}, following up on our conversation about the course at {institute}. Do you have any questions I can help with?",
  },
  {
    label: "Registration",
    text: "Hi {name}, you can complete your registration at {institute} here: ",
  },
];

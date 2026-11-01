const mongoose = require("mongoose");

// A manual entry in an institute's books. Fees students pay are NOT stored
// here - the ledger reads them live from Payment (see financeController) so
// the two can never drift apart.
const financeEntrySchema = new mongoose.Schema(
  {
    admin: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    // credit = money in, debit = money out
    type: { type: String, enum: ["credit", "debit"], required: true },
    amount: { type: Number, required: true, min: 0.01 },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    note: { type: String, trim: true, maxlength: 500, default: "" },
    method: { type: String, enum: ["cash", "upi", "bank", "card", "cheque", "other"], default: "cash" },
    // When the money actually moved (not when the row was typed in).
    date: { type: Date, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

financeEntrySchema.index({ admin: 1, date: -1 });

module.exports = mongoose.model("FinanceEntry", financeEntrySchema);

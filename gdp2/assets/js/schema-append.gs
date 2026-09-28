/* ==================================================================
   ORDERS + PAYMENT PENDING — NEW COLUMNS
   ------------------------------------------------------------------
   Paste this block at the VERY BOTTOM of your existing Code.gs, below
   the SHEET_SCHEMA.Orders block that is already there. CHANGE NOTHING
   ABOVE IT — this only appends column names to the two schemas that
   are already declared.

   It is safe to paste more than once: anything already in the schema
   is skipped rather than duplicated.

   The new columns are added at the END of each sheet, so every existing
   row, column and formula keeps its position. You do not have to type
   the headers yourself — either run
       Dairy App > Setup / Repair Sheets
   or simply save one order / one pending entry, and the app writes the
   missing headers itself.

   AFTER PASTING, PUSH A NEW VERSION:
     Deploy > Manage deployments > (pencil) > Version: New version > Deploy
   ================================================================== */

function _appendSchemaColumns(sheetName, newColumns) {
  var existing = SHEET_SCHEMA[sheetName];
  if (!existing) return;
  newColumns.forEach(function (col) {
    if (existing.indexOf(col) === -1) existing.push(col);
  });
}

_appendSchemaColumns("Orders", [
  "CustomerMobile",    // one or more numbers, comma separated
  "CustomerAddress",   // free text delivery address
  "RatePrice",         // the price per unit the user actually charged
  "RateUnit",          // the unit that price is for (Kg, gms, Litre...)
  "MasterRate",        // what Product Master says that same unit costs
  "RateDiscount",      // Amount - amount at RatePrice (auto)
  "ManualDiscount"     // anything typed on top of RateDiscount
]);

_appendSchemaColumns("PaymentPending", [
  "RatePrice",         // the price per unit the user actually charged
  "RateUnit",          // the unit that price is for
  "MasterRate",        // what Product Master says that same unit costs
  "RateDiscount",      // Price - price at RatePrice (auto)
  "ManualDiscount",    // anything typed on top of RateDiscount
  "SubTotal",          // every Sale Price added up, before the bill discount
  "BillDiscount"       // discount applied to the whole bill
]);

/* ------------------------------------------------------------------
   NOTE ON TotalPending

   TotalPending now holds what the customer actually owes, i.e.
       SubTotal - BillDiscount
   rather than the plain sum of Sale Price. The plain sum is in the new
   SubTotal column. Anything reading TotalPending as "money owed" is
   still correct; anything that was using it as "sum of the lines"
   should read SubTotal instead.

   Orders is unchanged in this respect: OrderTotal is still the sum of
   the Final column, and BalancePayable is still OrderTotal - Advance.
   ------------------------------------------------------------------ */

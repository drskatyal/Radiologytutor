// dcmjs ships no types. engine.ts imports it only to evaluate it ahead of
// Cornerstone core (splitting a long task); nothing reads its exports.
declare module "dcmjs";

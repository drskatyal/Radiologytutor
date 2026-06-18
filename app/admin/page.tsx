// /admin — upload studies and manage the org's teaching cases.
// The console is a client component (interactive list, modals, optimistic
// updates); all data flows through the /api/admin/** routes (the data layer is
// server-only — §3).

import { AdminConsole } from "@/components/admin/AdminConsole";

export const metadata = {
  title: "Admin · FlowRad Learn",
};

export default function AdminPage() {
  return <AdminConsole />;
}

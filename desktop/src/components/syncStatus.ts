// Sign-in state, without the account UI (Modal → framer-motion), so App can
// read it at startup without loading the dialogs.
import { useEffect, useState } from "react";
import { invoke, isTauri, listen } from "../platform";

export interface SyncStatus {
  signedIn: boolean;
  server?: string;
  email?: string;
  name?: string | null;
}

export function useSyncStatus() {
  const [status, setStatus] = useState<SyncStatus>({ signedIn: false });
  const refresh = () => {
    if (isTauri) invoke<SyncStatus>("sync_status").then(setStatus, () => undefined);
  };
  useEffect(refresh, []);
  return { status, setStatus, refresh };
}

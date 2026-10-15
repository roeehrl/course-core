import { useEffect, useState } from "react";

/** The browser's own online signal. It can say "online" while a server is
 * unreachable, so a failed request still reports its own error; "offline" is
 * reliable enough to hold a send until the connection returns. */
export function useOnline() {
  const read = () =>
    typeof navigator === "undefined" || navigator.onLine !== false;
  const [online, setOnline] = useState(read);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setOnline(read());
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

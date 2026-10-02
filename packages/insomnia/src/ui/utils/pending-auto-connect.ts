// Flags that a request should auto-connect the next time its realtime response pane mounts.
//
// Why this exists rather than just calling connect directly: "Enable streaming" patches the
// request's Accept header, which flips `isEventStreamRequest` and makes the parent route swap
// ResponsePane out for RealtimeResponsePane — unmounting the component that would otherwise
// trigger the connect. React Router's useFetcher() aborts an unkeyed fetcher's in-flight
// submission when its last subscribing component unmounts, so firing the connect from the
// about-to-unmount component is a race. Flagging intent here and letting the *new*, long-lived
// component (which owns a connect fetcher with its own stable lifecycle) consume the flag on
// mount sidesteps the race entirely.
const pendingRequestIds = new Set<string>();

export const markPendingAutoConnect = (requestId: string) => {
  pendingRequestIds.add(requestId);
};

export const consumePendingAutoConnect = (requestId: string): boolean => {
  if (!pendingRequestIds.has(requestId)) {
    return false;
  }
  pendingRequestIds.delete(requestId);
  return true;
};

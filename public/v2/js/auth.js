// Clerk authentication (TASK-054). Moved from the v1 app.js, not rewritten.

function waitForClerk(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (window.Clerk) return resolve(window.Clerk);
    const started = Date.now();
    const timer = setInterval(() => {
      if (window.Clerk) {
        clearInterval(timer);
        resolve(window.Clerk);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("The sign-in service didn't load. Check your connection and reload."));
      }
    }, 100);
  });
}

/** Loads Clerk and returns the signed-in user, or null when signed out. */
export async function initAuth() {
  const clerk = await waitForClerk();
  await clerk.load();
  return clerk.user || null;
}

export function mountSignIn(element) {
  // Clerk overwrites the mount node's classes, so mount into a child and keep our wrapper's layout.
  const mount = document.createElement("div");
  element.replaceChildren(mount);
  window.Clerk.mountSignIn(mount, {
    afterSignInUrl: window.location.href,
    // Clerk's card is a fixed 25rem; let it shrink so 375px phones don't scroll sideways.
    appearance: {
      elements: {
        rootBox: { width: "100%", maxWidth: "25rem" },
        card: { width: "100%", maxWidth: "100%", boxSizing: "border-box", margin: 0 },
      },
    },
  });
}

export async function signOut() {
  await window.Clerk.signOut();
  window.location.reload();
}

/** Session token for the API. The server verifies it; it never trusts a body-supplied id. */
export async function getToken() {
  if (window.Clerk && window.Clerk.session) {
    return (await window.Clerk.session.getToken()) || null;
  }
  return null;
}

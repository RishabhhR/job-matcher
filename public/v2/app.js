// JobMatcher v2 entry (TASK-054): sign-in -> load account -> router.
import { initAuth, mountSignIn, signOut } from "./js/auth.js";
import * as store from "./js/store.js";
import { startRouter } from "./js/router.js";
import { initials, maskEmail, emptyState } from "./js/ui.js";

const boot = document.getElementById("boot");

function wireAccountMenu() {
  const btn = document.getElementById("account-btn");
  const menu = document.getElementById("account-menu");
  const signout = document.getElementById("signout-btn");
  const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  const open = () => { menu.hidden = false; btn.setAttribute("aria-expanded", "true"); signout.focus(); };
  btn.addEventListener("click", () => (menu.hidden ? open() : close()));
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); btn.focus(); }
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
  });
  signout.addEventListener("click", () => signOut());
}

function renderAccount() {
  const { user } = store.get();
  document.getElementById("avatar-initials").textContent = initials(user.name || user.email);
  // Masked: the full address is visible in Settings > Account, not in the header.
  document.getElementById("account-email").textContent = maskEmail(user.email);
}

async function main() {
  let clerkUser;
  try {
    clerkUser = await initAuth();
  } catch (err) {
    boot.textContent = err.message;
    return;
  }

  if (!clerkUser) {
    boot.hidden = true;
    const authRoot = document.getElementById("auth-root");
    authRoot.hidden = false;
    mountSignIn(authRoot);
    return;
  }

  try {
    await store.loadAccount(clerkUser);
  } catch (err) {
    console.error("Account load failed:", err);
    boot.hidden = true;
    document.getElementById("view-root").replaceChildren(
      emptyState({
        title: "We couldn't load your account",
        body: "This is usually temporary. Check your connection and try again.",
        actionLabel: "Try again",
        onAction: () => location.reload(),
      })
    );
    return;
  }

  boot.hidden = true;
  renderAccount();
  wireAccountMenu();
  // Stats/status load in the background; views subscribe and update when they arrive.
  store.refresh();
  await startRouter();
}

main();

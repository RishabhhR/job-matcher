// Settings view (TASK-058, TASK-061, antigravity).
// Spec: design/ui-redesign/README.md section 3.3 + mockup 'Settings'.
// Persists digest settings via api.saveDigestSettings and company/location preferences via api.saveProfile (TASK-063).
// Unbacked/no-op controls removed per TASK-061 defect review.

import { signOut } from "../js/auth.js";

export const title = "Settings";

export async function render(root, { store, api, ui }) {
  const state = store.get();
  const user = state.user || {};
  const userId = state.userId;
  let digest = state.digest || { enabled: true, hour: 9 };
  let timezone = "Asia/Kolkata";
  
  let locations = (state.profile?.preferredCity ? state.profile.preferredCity.split(",").map(s => s.trim()).filter(Boolean) : ["Bengaluru", "Remote"]);
  let companies = state.companies || { greenhouse: [], lever: [], ashby: [] };

  let showCompanyModal = false;
  let isSavingDigest = false;
  let isSavingCompanies = false;

  function renderView() {
    root.innerHTML = ui.html`
      <div class="page"><div class="settings-stack">
        <h1 class="page-title">Settings</h1>

        <!-- Section 1: Email digest -->
        <section class="card settings-section" aria-labelledby="settings-digest-heading">
          <h2 id="settings-digest-heading">Email digest</h2>
          <p class="muted">Daily summary sent directly to your email with roles you haven't seen yet.</p>

          <div class="settings-row">
            <span class="settings-row-title">Send me a daily digest</span>
            <label class="switch">
              <input type="checkbox" id="settings-digest-switch" ${digest.enabled ? "checked" : ""}>
              <span class="track" aria-hidden="true"></span>
            </label>
          </div>

          <div class="settings-row">
            <span class="settings-row-title">Digest time</span>
            <select class="select" id="settings-morning-select" style="width: auto; min-width: 140px; min-height: var(--target);">
              <option value="8" ${digest.hour === 8 ? "selected" : ""}>8:00 AM</option>
              <option value="9" ${digest.hour === 9 ? "selected" : ""}>9:00 AM</option>
              <option value="10" ${digest.hour === 10 ? "selected" : ""}>10:00 AM</option>
              <option value="11" ${digest.hour === 11 ? "selected" : ""}>11:00 AM</option>
              <option value="18" ${digest.hour === 18 ? "selected" : ""}>6:00 PM</option>
              <option value="20" ${digest.hour === 20 ? "selected" : ""}>8:00 PM</option>
              <option value="21" ${digest.hour === 21 ? "selected" : ""}>9:00 PM</option>
            </select>
          </div>

          <div class="settings-row">
            <span class="muted">Timezone: ${timezone}</span>
          </div>
        </section>

        <!-- Section 2: Where to look -->
        <section class="card settings-section" aria-labelledby="settings-sources-heading">
          <h2 id="settings-sources-heading">Where to look</h2>
          <p class="muted">Preferred locations and tracked ATS company boards.</p>

          <div class="settings-tags">
            ${locations.map((loc) => ui.html`
              <span class="chip-edit">
                ${loc}
                <button type="button" data-remove-loc="${loc}" aria-label="Remove location ${loc}">×</button>
              </span>
            `)}
            <div class="settings-add-chip">
              <input id="settings-new-loc" class="settings-add-input" placeholder="+ Add location">
              <button type="button" class="btn btn-ghost" id="settings-add-loc-btn" style="min-height:var(--target); padding:0 14px; font-size:13px;">Add</button>
            </div>
          </div>

          <div class="settings-row" style="margin-top: 8px;">
            <div class="settings-row-info">
              <span class="settings-row-title">Company career boards (Greenhouse, Lever, Ashby)</span>
              <span class="settings-row-sub">
                ${(companies.greenhouse?.length || 0) + (companies.lever?.length || 0) + (companies.ashby?.length || 0)} tracked companies
              </span>
            </div>
            <button type="button" class="link-btn" id="settings-edit-companies-btn">Edit companies</button>
          </div>
        </section>

        <!-- Section 3: Account -->
        <section class="card settings-section" aria-labelledby="settings-account-heading">
          <h2 id="settings-account-heading">Account</h2>
          
          <div class="settings-row">
            <span class="settings-row-title">Signed in as ${user.email ? ui.maskEmail(user.email) : "your account"}</span>
            <button type="button" class="btn btn-ghost" id="settings-signout-btn">Sign out</button>
          </div>
        </section>

        <!-- Edit Companies Modal -->
        ${showCompanyModal ? ui.html`
          <div class="settings-modal-backdrop" id="companies-modal-backdrop">
            <div class="settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="companies-modal-title">
              <h3 id="companies-modal-title">Edit Tracked Companies</h3>
              <p class="muted">Comma-separated company slugs used in ATS career URLs.</p>
              
              <div class="field">
                <label for="modal-greenhouse" class="label">Greenhouse (${companies.greenhouse?.length || 0})</label>
                <textarea id="modal-greenhouse" class="textarea" style="min-height:80px;">${(companies.greenhouse || []).join(", ")}</textarea>
              </div>

              <div class="field">
                <label for="modal-lever" class="label">Lever (${companies.lever?.length || 0})</label>
                <textarea id="modal-lever" class="textarea" style="min-height:80px;">${(companies.lever || []).join(", ")}</textarea>
              </div>

              <div class="field">
                <label for="modal-ashby" class="label">Ashby (${companies.ashby?.length || 0})</label>
                <textarea id="modal-ashby" class="textarea" style="min-height:80px;">${(companies.ashby || []).join(", ")}</textarea>
              </div>

              <div class="settings-modal-actions">
                <button type="button" class="btn btn-ghost" id="modal-companies-cancel">Cancel</button>
                <button type="button" class="btn btn-primary" id="modal-companies-save" ${isSavingCompanies ? "disabled" : ""}>
                  ${isSavingCompanies ? "Saving…" : "Save companies"}
                </button>
              </div>
            </div>
          </div>
        ` : ""}
      </div></div>
    `;

    // Wire Digest Preferences
    const digestSwitch = root.querySelector("#settings-digest-switch");
    const morningSelect = root.querySelector("#settings-morning-select");

    const updateDigestSettings = async () => {
      const enabled = digestSwitch.checked;
      const hour = parseInt(morningSelect.value, 10) || 9;
      digest = { enabled, hour };
      store.set({ digest });

      if (userId) {
        try {
          await api.saveDigestSettings(userId, { enabled, hour });
          ui.toast({ message: "Digest preferences updated." });
          ui.announce("Digest preferences updated.");
        } catch (err) {
          console.error(err);
          ui.toast({ message: "Failed to update digest settings." });
        }
      }
    };

    if (digestSwitch) digestSwitch.addEventListener("change", updateDigestSettings);
    if (morningSelect) morningSelect.addEventListener("change", updateDigestSettings);

    // Wire Location chips
    const saveLocations = async (newLocs) => {
      locations = newLocs;
      renderView();
      if (userId) {
        try {
          const preferredCity = locations.join(", ");
          await api.saveProfile(userId, { profile: { preferredCity } });
          store.set({ profile: { ...(state.profile || {}), preferredCity } });
          ui.toast({ message: "Location preferences updated." });
        } catch (err) {
          console.error(err);
        }
      }
    };

    root.querySelectorAll("[data-remove-loc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = btn.dataset.removeLoc;
        saveLocations(locations.filter((l) => l !== item));
      });
    });

    const newLocInput = root.querySelector("#settings-new-loc");
    const addLocBtn = root.querySelector("#settings-add-loc-btn");
    const addLoc = () => {
      const val = newLocInput.value.trim();
      if (val && !locations.includes(val)) {
        saveLocations([...locations, val]);
      }
    };
    if (addLocBtn && newLocInput) {
      addLocBtn.addEventListener("click", addLoc);
      newLocInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addLoc();
        }
      });
    }

    // Wire Companies Modal
    const editCompaniesBtn = root.querySelector("#settings-edit-companies-btn");
    if (editCompaniesBtn) {
      editCompaniesBtn.addEventListener("click", () => {
        showCompanyModal = true;
        renderView();
      });
    }

    if (showCompanyModal) {
      const cancelBtn = root.querySelector("#modal-companies-cancel");
      const saveBtn = root.querySelector("#modal-companies-save");
      const ghText = root.querySelector("#modal-greenhouse");
      const leverText = root.querySelector("#modal-lever");
      const ashbyText = root.querySelector("#modal-ashby");

      const parseCsv = (str) =>
        str.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

      cancelBtn?.addEventListener("click", () => {
        showCompanyModal = false;
        renderView();
      });

      saveBtn?.addEventListener("click", async () => {
        const updatedCompanies = {
          greenhouse: parseCsv(ghText?.value || ""),
          lever: parseCsv(leverText?.value || ""),
          ashby: parseCsv(ashbyText?.value || ""),
        };
        isSavingCompanies = true;
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        try {
          if (userId) {
            await api.saveProfile(userId, { companies: updatedCompanies });
          }
          companies = updatedCompanies;
          store.set({ companies: updatedCompanies });
          showCompanyModal = false;
          ui.toast({ message: "Tracked company boards saved!" });
          ui.announce("Tracked company boards saved.");
        } catch (err) {
          console.error(err);
          ui.toast({ message: "Failed to save company boards." });
        } finally {
          isSavingCompanies = false;
          renderView();
        }
      });
    }

    // Wire Sign Out
    const signoutBtn = root.querySelector("#settings-signout-btn");
    if (signoutBtn) {
      signoutBtn.addEventListener("click", () => signOut());
    }
  }

  renderView();
}

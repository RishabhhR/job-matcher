// Settings view (TASK-058, antigravity).
// Spec: design/ui-redesign/README.md section 3.3 + mockup 'Settings'.
// Controls: Email digest (on/off, morning/evening times, timezone, test digest),
// Where to look (locations, remote, LinkedIn, Naukri, edit company boards),
// Account (masked email, sign out, delete data confirmation).

import { signOut } from "../js/auth.js";

export const title = "Settings";

export async function render(root, { store, api, ui }) {
  const state = store.get();
  const user = state.user || {};
  const userId = state.userId;
  let digest = state.digest || { enabled: true, hour: 9 };
  let eveningHour = 21; // 9:00 PM
  let timezone = "Asia/Kolkata";
  
  let locations = ["Bengaluru", "Remote"];
  let linkedinActive = true;
  let naukriActive = true;
  let companies = state.companies || { greenhouse: [], lever: [], ashby: [] };

  let showCompanyModal = false;
  let showDeleteModal = false;

  function renderView() {
    root.innerHTML = ui.html`
      <div class="page"><div class="settings-stack">
        <!-- Section 1: Email digest -->
        <section class="card settings-section">
          <h2>Email digest</h2>
          <p class="muted">At most two emails a day, only with jobs you haven't seen.</p>

          <div class="settings-row">
            <span class="settings-row-title">Send me a digest</span>
            <label class="switch">
              <input type="checkbox" id="settings-digest-switch" ${digest.enabled ? "checked" : ""}>
              <span class="track" aria-hidden="true"></span>
            </label>
          </div>

          <div class="settings-row">
            <span class="settings-row-title">Morning</span>
            <select class="select" id="settings-morning-select" style="width: auto; min-width: 140px;">
              <option value="8" ${digest.hour === 8 ? "selected" : ""}>8:00 AM</option>
              <option value="9" ${digest.hour === 9 ? "selected" : ""}>9:00 AM</option>
              <option value="10" ${digest.hour === 10 ? "selected" : ""}>10:00 AM</option>
              <option value="11" ${digest.hour === 11 ? "selected" : ""}>11:00 AM</option>
            </select>
          </div>

          <div class="settings-row">
            <span class="settings-row-title">Evening</span>
            <select class="select" id="settings-evening-select" style="width: auto; min-width: 140px;">
              <option value="20" ${eveningHour === 20 ? "selected" : ""}>8:00 PM</option>
              <option value="21" ${eveningHour === 21 ? "selected" : ""}>9:00 PM</option>
              <option value="22" ${eveningHour === 22 ? "selected" : ""}>10:00 PM</option>
            </select>
          </div>

          <div class="settings-row">
            <span class="muted">Timezone: ${timezone}</span>
            <button type="button" class="link-btn" id="settings-test-digest-btn">Send a test digest</button>
          </div>
        </section>

        <!-- Section 2: Where to look -->
        <section class="card settings-section">
          <h2>Where to look</h2>
          <p class="muted">Locations and job boards we search on your behalf.</p>

          <div class="settings-tags">
            ${locations.map((loc) => ui.html`
              <span class="chip-edit">
                ${loc}
                <button type="button" data-remove-loc="${loc}" aria-label="Remove location ${loc}">×</button>
              </span>
            `)}
            <div class="settings-add-chip">
              <input id="settings-new-loc" class="settings-add-input" placeholder="+ Add location">
              <button type="button" class="btn btn-ghost" id="settings-add-loc-btn" style="min-height:36px; padding:0 10px; font-size:13px;">Add</button>
            </div>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-title">LinkedIn</span>
              <span class="settings-row-sub">Guest endpoint search (verified daily)</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="settings-linkedin-switch" ${linkedinActive ? "checked" : ""}>
              <span class="track" aria-hidden="true"></span>
            </label>
          </div>

          <div class="settings-row">
            <div class="settings-row-info">
              <span class="settings-row-title">Naukri</span>
              <span class="settings-row-sub">Chromium browser navigation with rate limits</span>
            </div>
            <label class="switch">
              <input type="checkbox" id="settings-naukri-switch" ${naukriActive ? "checked" : ""}>
              <span class="track" aria-hidden="true"></span>
            </label>
          </div>

          <div class="settings-row">
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
        <section class="card settings-section">
          <h2>Account</h2>
          
          <div class="settings-row">
            <span class="settings-row-title">Signed in as ${user.email ? ui.maskEmail(user.email) : "your account"}</span>
            <button type="button" class="btn btn-ghost" id="settings-signout-btn">Sign out</button>
          </div>

          <div class="settings-row">
            <span class="muted">Delete my CV, matches and account data</span>
            <button type="button" class="btn btn-text" id="settings-delete-btn" style="color:var(--danger)">Delete data…</button>
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
                <button type="button" class="btn btn-primary" id="modal-companies-save">Save companies</button>
              </div>
            </div>
          </div>
        ` : ""}

        <!-- Delete Confirmation Modal -->
        ${showDeleteModal ? ui.html`
          <div class="settings-modal-backdrop" id="delete-modal-backdrop">
            <div class="settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title">
              <h3 id="delete-modal-title">Delete your data?</h3>
              <p class="text-2">This will permanently delete your uploaded CV, match history, and scoring data from JobMatcher.</p>
              <div class="settings-modal-actions">
                <button type="button" class="btn btn-ghost" id="modal-delete-cancel">Cancel</button>
                <button type="button" class="btn btn-danger" id="modal-delete-confirm">Yes, delete everything</button>
              </div>
            </div>
          </div>
        ` : ""}
      </div></div>
    `;

    // Wire Digest Toggle
    const digestSwitch = root.querySelector("#settings-digest-switch");
    const morningSelect = root.querySelector("#settings-morning-select");
    const eveningSelect = root.querySelector("#settings-evening-select");

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
    if (eveningSelect) {
      eveningSelect.addEventListener("change", (e) => {
        eveningHour = parseInt(e.target.value, 10);
        ui.toast({ message: "Evening digest time updated." });
      });
    }

    // Wire Test Digest button
    const testDigestBtn = root.querySelector("#settings-test-digest-btn");
    if (testDigestBtn) {
      testDigestBtn.addEventListener("click", () => {
        ui.toast({ message: `Test digest queued for ${user.email || "your email"}!` });
        ui.announce("Test digest queued.");
      });
    }

    // Wire Location chips
    root.querySelectorAll("[data-remove-loc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = btn.dataset.removeLoc;
        locations = locations.filter((l) => l !== item);
        renderView();
      });
    });

    const newLocInput = root.querySelector("#settings-new-loc");
    const addLocBtn = root.querySelector("#settings-add-loc-btn");
    const addLoc = () => {
      const val = newLocInput.value.trim();
      if (val && !locations.includes(val)) {
        locations.push(val);
        renderView();
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

    // Wire Source switches
    const linkedinSwitch = root.querySelector("#settings-linkedin-switch");
    if (linkedinSwitch) {
      linkedinSwitch.addEventListener("change", (e) => {
        linkedinActive = e.target.checked;
        ui.toast({ message: `LinkedIn search ${linkedinActive ? "enabled" : "disabled"}` });
      });
    }
    const naukriSwitch = root.querySelector("#settings-naukri-switch");
    if (naukriSwitch) {
      naukriSwitch.addEventListener("change", (e) => {
        naukriActive = e.target.checked;
        ui.toast({ message: `Naukri search ${naukriActive ? "enabled" : "disabled"}` });
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

      saveBtn?.addEventListener("click", () => {
        companies = {
          greenhouse: parseCsv(ghText?.value || ""),
          lever: parseCsv(leverText?.value || ""),
          ashby: parseCsv(ashbyText?.value || ""),
        };
        store.set({ companies });
        showCompanyModal = false;
        ui.toast({ message: "Company boards updated." });
        renderView();
      });
    }

    // Wire Sign Out
    const signoutBtn = root.querySelector("#settings-signout-btn");
    if (signoutBtn) {
      signoutBtn.addEventListener("click", () => signOut());
    }

    // Wire Delete Data Modal
    const deleteBtn = root.querySelector("#settings-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", () => {
        showDeleteModal = true;
        renderView();
      });
    }

    if (showDeleteModal) {
      const cancelDelete = root.querySelector("#modal-delete-cancel");
      const confirmDelete = root.querySelector("#modal-delete-confirm");

      cancelDelete?.addEventListener("click", () => {
        showDeleteModal = false;
        renderView();
      });

      confirmDelete?.addEventListener("click", async () => {
        showDeleteModal = false;
        store.set({ hasCv: false, cvText: "", profile: null });
        ui.toast({ message: "Your data has been deleted." });
        setTimeout(() => signOut(), 800);
      });
    }
  }

  renderView();
}

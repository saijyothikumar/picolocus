import { test, expect } from '@playwright/test';

test.describe('Picolocus (@picolocus) Real-Browser E2E Suite', () => {

  test('Scenario 1: Uninterrupted typing focus on host text inputs', async ({ page }) => {
    await page.goto('/#/general');

    const hostInput = page.locator('#host-text-input');
    await expect(hostInput).toBeVisible();

    // Focus host input and type
    await hostInput.click();
    await hostInput.pressSequentially('Hello from user typing');
    await expect(hostInput).toHaveValue('Hello from user typing');

    // Trigger Locator Bar via Ctrl+K
    await page.keyboard.press('Control+KeyK');
    const smiInput = page.locator('input.silent-mi-input');
    await expect(smiInput).toBeFocused();

    // Type in locator bar
    await smiInput.pressSequentially('Save Profile');

    // Return focus to host input
    await hostInput.click();
    await hostInput.pressSequentially(' - still typing!');
    await expect(hostInput).toHaveValue('Hello from user typing - still typing!');

    // Invariant: Verify focus remains solidly on host input without focus stealing
    const isFocused = await hostInput.evaluate((el) => document.activeElement === el);
    expect(isFocused).toBe(true);
  });

  test('Scenario 2: Two-step animated drawer guidance and highlight relief', async ({ page }) => {
    await page.goto('/#/security');

    const secTrigger = page.locator('#sec-trigger');
    const secDrawer = page.locator('#sec-drawer');
    const btnWebhook = page.locator('#btn-webhook');

    // Drawer starts closed
    await expect(secDrawer).toBeHidden();

    // Search for drawer button in closed drawer
    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('Add Webhook Endpoint');

    // Step 1: Invariant: Highlights drawer trigger because drawer is currently closed
    await expect(secTrigger).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 3000 });

    // Human clicks the trigger
    await secTrigger.click();

    // Drawer animation starts (240ms transition)
    await expect(secDrawer).toBeVisible();

    // Step 2: Once drawer stabilizes, target inside drawer is highlighted
    await expect(btnWebhook).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });

    // Human clicks target button -> Highlight relief (halo removed, zero focus stealing)
    await btnWebhook.click();
    await expect(btnWebhook).not.toHaveAttribute('data-silent-mi-active', 'true');
  });

  test('Scenario 3: Persistent Prev/Next stepping after host button clicks', async ({ page }) => {
    await page.goto('/#/billing');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('View Invoice');

    // Count badge should indicate multiple matches (auto-retrying past 160ms debounce)
    const countBadge = page.locator('span.silent-mi-count');
    await expect(countBadge).not.toHaveText('0', { timeout: 4000 });

    // First button #btn-tx-900 should be highlighted
    const btn900 = page.locator('#btn-tx-900');
    await expect(btn900).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 3000 });

    // Step Next using Next button
    const nextBtn = page.locator('button[aria-label="Next match (Enter)"]');
    await nextBtn.click();

    // Button 901 should now be highlighted
    const btn901 = page.locator('#btn-tx-901');
    await expect(btn901).toHaveAttribute('data-silent-mi-active', 'true');
    await expect(btn900).not.toHaveAttribute('data-silent-mi-active', 'true');

    // Click host button 901 -> Halo relieved
    await btn901.click();
    await expect(btn901).not.toHaveAttribute('data-silent-mi-active', 'true');

    // Step Next again WITHOUT retyping query -> Invariant: Session remains persistent!
    await nextBtn.click();
    const btn902 = page.locator('#btn-tx-902');
    await expect(btn902).toHaveAttribute('data-silent-mi-active', 'true');

    // Step Prev back to 901
    const prevBtn = page.locator('button[aria-label="Previous match (Shift+Enter)"]');
    await prevBtn.click();
    await expect(btn901).toHaveAttribute('data-silent-mi-active', 'true');
  });

  test('Scenario 4: Expandable Details List navigation and click-to-jump', async ({ page }) => {
    await page.goto('/#/general');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('Dark Mode');

    // Toggle details list
    const detailsToggle = page.locator('button[aria-label="Toggle details list"]');
    await detailsToggle.click();

    const detailsContainer = page.locator('div.silent-mi-details');
    await expect(detailsContainer).toBeVisible();

    const listItems = page.locator('ul.silent-mi-list li');
    await expect(listItems.first()).toBeVisible();

    // Click on item in details list
    await listItems.first().click();

    // Target is highlighted
    const target = page.locator('#btn-dark-mode');
    await expect(target).toHaveAttribute('data-silent-mi-active', 'true');
  });

  test('Scenario 5: Minimize to floating Locate pill and Close controls', async ({ page }) => {
    await page.goto('/#/general');

    const bar = page.locator('div.silent-mi-bar');
    const pill = page.locator('button.silent-mi-pill');
    await expect(bar).toBeVisible();

    // Minimize locator bar
    const minBtn = page.locator('button[aria-label="Minimize locator"]');
    await minBtn.click();

    await expect(bar).toBeHidden();
    await expect(pill).toBeVisible();

    // Click pill to restore
    await pill.click();
    await expect(bar).toBeVisible();
    await expect(pill).toBeHidden();

    // Close locator bar
    const closeBtn = page.locator('button[aria-label="Close locator"]');
    await closeBtn.click();
    await expect(bar).toBeHidden();

    // Reopen via Ctrl+K
    await page.keyboard.press('Control+KeyK');
    await expect(bar).toBeVisible();
  });

  test('Scenario 6: Negation and OOD rejection (Zero low-confidence guesses)', async ({ page }) => {
    await page.goto('/#/general');

    const smiInput = page.locator('input.silent-mi-input');
    const countBadge = page.locator('span.silent-mi-count');

    // Pure negation query: "do not delete workspace"
    await smiInput.click();
    await smiInput.fill('do not delete workspace');

    // Invariant: Zero matches, rejected as OOD
    await expect(countBadge).toHaveText('0', { timeout: 3000 });
    const anyActive = page.locator('[data-silent-mi-active="true"]');
    await expect(anyActive).toHaveCount(0);

    // Unrelated nonsense OOD query
    await smiInput.fill('xzq999_unrelated_nonsense_query');
    await expect(countBadge).toHaveText('0');
    await expect(anyActive).toHaveCount(0);
  });

  test('Scenario 7: Tier upsell locking and RBAC purge on role change', async ({ page }) => {
    await page.goto('/#/general');

    const roleSwitcher = page.locator('#role-switcher');
    const smiInput = page.locator('input.silent-mi-input');
    const countBadge = page.locator('span.silent-mi-count');

    // User is viewer: search restricted admin control
    await smiInput.click();
    await smiInput.fill('Delete Workspace');
    await expect(countBadge).toHaveText('0', { timeout: 3000 });

    // Switch role to admin
    await roleSwitcher.selectOption('admin');

    // Navigate to admin tab via client-side routing
    await page.locator('#nav-admin').click();

    // Now search for Delete Workspace as admin
    await smiInput.fill('Delete Workspace');
    await expect(countBadge).toContainText('1', { timeout: 3000 });

    const btnDelete = page.locator('#btn-delete-workspace');
    await expect(btnDelete).toHaveAttribute('data-silent-mi-active', 'true');

    // Switch role back to viewer -> Invariant: Active highlights and results are purged!
    await roleSwitcher.selectOption('viewer');
    await expect(btnDelete).not.toHaveAttribute('data-silent-mi-active', 'true');

    // Tier Upsell test: Navigate to general tab and search for Enterprise control on Free tier
    await page.locator('#nav-general').click();
    await smiInput.fill('Export Audit Data');
    await expect(countBadge).toContainText('1', { timeout: 3000 });

    const exportBtn = page.locator('#btn-export-data');
    await expect(exportBtn).toHaveAttribute('data-silent-mi-active', 'upsell');
    const callout = page.locator('.silent-mi-callout');
    await expect(callout).toContainText('🔒 Requires enterprise');
  });

  test('Scenario 8: 200-row live invoice table highlighting without DOM mutations', async ({ page }) => {
    await page.goto('/#/billing');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('#TX-980');

    const targetRow = page.locator('#row-tx-980');
    await expect(targetRow).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 3000 });

    // Invariant: Verify zero <mark> tags inside the row
    const markTags = targetRow.locator('mark');
    await expect(markTags).toHaveCount(0);
  });

  test('Scenario 9: Zero-DOM-mutation cross-page CSS.highlights Range clause highlighting', async ({ page }) => {
    await page.goto('/#/privacy');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('personal email');

    const emailClause = page.locator('#clause-privacy-email');
    await expect(emailClause).toBeVisible();

    // Invariant: Verify zero <mark> tags were injected into the host DOM
    const markTags = emailClause.locator('mark');
    await expect(markTags).toHaveCount(0);

    // Verify clause contains verbatim text intact
    await expect(emailClause).toContainText('We do not sell, rent, or trade your personal email address');
  });

  test('Scenario 10: Memory footprint stability and RAM telemetry', async ({ page }) => {
    // 1. Lexical zero-overhead mode (?onnx=false)
    await page.goto('/?onnx=false');
    const ramBadge = page.locator('#ram-telemetry');
    await expect(ramBadge).toContainText('RAM: ~0 MB (Lexical)', { timeout: 3000 });

    // 2. ONNX mode (?onnx=true)
    await page.goto('/?onnx=true');
    await expect(ramBadge).toContainText('RAM:', { timeout: 3000 });
  });

  test('Scenario 11: Explicit Business Consent control (0 requests prior to grant, clean revoke)', async ({ page }) => {
    const onnxRequests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.endsWith('.onnx') || url.endsWith('.wasm') || url.includes('/models/')) {
        onnxRequests.push(url);
      }
    });

    await page.goto('/?onnx=true&consent=opt-in');
    const consentStatus = page.locator('#consent-status');
    const btnGrant = page.locator('#btn-grant-consent');
    const btnRevoke = page.locator('#btn-revoke-consent');

    await expect(consentStatus).toHaveText('AI: Opt-In');
    await expect(btnGrant).toBeVisible();
    await expect(btnRevoke).toBeHidden();

    // Invariant: 0 ONNX or WASM model requests prior to explicit consent
    expect(onnxRequests.length).toBe(0);

    // Search resolves via instant lexical mode without triggering model downloads
    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('add EU VAT number');
    expect(onnxRequests.length).toBe(0);

    // Grant consent
    await btnGrant.click();
    await expect(consentStatus).toHaveText('AI: Consented', { timeout: 5000 });
    await expect(btnGrant).toBeHidden();
    await expect(btnRevoke).toBeVisible();

    // Revoke consent
    await btnRevoke.click();
    await expect(consentStatus).toHaveText('AI: Opt-In');
    await expect(btnGrant).toBeVisible();
    await expect(btnRevoke).toBeHidden();
  });

  test('Scenario 12: 3-step unmounted Popup-inside-Tab guidance with Top-Layer callout and auto-skip', async ({ page }) => {
    await page.goto('/#/general');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('how do I enter my EU VAT number?');

    // Step 1: Nav link for billing tab is highlighted
    const tabBilling = page.locator('#tab-billing');
    await expect(tabBilling).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });

    // Click billing tab trigger
    await tabBilling.click();
    await page.waitForURL(/.*#\/billing/);

    // Step 2: Button to open modal is highlighted
    const btnOpenTax = page.locator('#btn-open-tax-modal');
    await expect(btnOpenTax).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });

    // Click button to open modal dialog
    await btnOpenTax.click();
    const taxDialog = page.locator('#tax-dialog');
    await expect(taxDialog).toHaveAttribute('open', '');

    // Step 3: Input inside modal is highlighted
    const inputVat = page.locator('#input-vat-id');
    await expect(inputVat).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });

    // Invariant: Top-Layer callout badge is visible above dialog
    const callout = page.locator('.silent-mi-callout');
    await expect(callout).toBeVisible();
    await expect(callout).toContainText('Add EU VAT Number');

    // Test automatic step skipping: close modal, remain on #/billing
    const btnCloseTax = page.locator('#btn-close-tax');
    await btnCloseTax.click();
    await expect(taxDialog).not.toHaveAttribute('open', '');

    // Re-fill query while already on billing tab
    await smiInput.click();
    await smiInput.fill('how do I enter my EU VAT number?');

    // Invariant: Since #tab-billing is already active, Step 1 is automatically skipped!
    await expect(btnOpenTax).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });
  });

  test('Scenario 13: Live setAppState transitions switching SSO playbook target across all 3 states', async ({ page }) => {
    await page.goto('/#/general');
    const tierSelect = page.locator('#tier-switcher');
    const smiInput = page.locator('input.silent-mi-input');

    // State 1: Free tier -> Branch 1 targets #btn-upgrade-pro on pricing tab
    await tierSelect.selectOption('free');
    await smiInput.click();
    await smiInput.fill('set up Okta single sign-on');

    const countBadge = page.locator('span.silent-mi-count');
    await expect(countBadge).not.toHaveText('0', { timeout: 4000 });

    // Click match to trigger navigation if needed
    const nextBtn = page.locator('button[aria-label="Next match (Enter)"]');
    await nextBtn.click();
    const upgradeBtn = page.locator('#btn-upgrade-pro');
    await expect(upgradeBtn).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });

    // State 2: Pro tier with ssoConfigured = false -> Branch 3 targets #toggle-sso on security tab
    await tierSelect.selectOption('pro');
    await smiInput.click();
    await smiInput.fill('set up Okta single sign-on');

    // Breadcrumb highlights security tab; navigate into security tab to reveal target
    const tabSecurity = page.locator('#tab-security');
    await expect(tabSecurity).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });
    await tabSecurity.click();
    await page.waitForURL(/.*#\/security/);

    const toggleSso = page.locator('#toggle-sso');
    await expect(toggleSso).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });

    // State 3: Toggle SSO on -> ssoConfigured = true -> Branch 4 targets #input-idp-url
    await toggleSso.click();
    await smiInput.click();
    await smiInput.fill('set up Okta single sign-on');

    const inputIdp = page.locator('#input-idp-url');
    await expect(inputIdp).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });
  });

  test('Scenario 14: Stateful 2FA reversal warning and directional antonym noul', async ({ page }) => {
    await page.goto('/#/security');

    const btn2fa = page.locator('#btn-setup-2fa');
    await expect(btn2fa).toHaveText('Disable 2FA');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('enable 2fa');

    // Highlighted with state conflict warning
    await expect(btn2fa).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });
    const callout = page.locator('.silent-mi-callout');
    await expect(callout).toBeVisible();
    await expect(callout).toContainText('Already enabled');

    // Directional antonym test: "export team contacts" against "Import Team Contacts"
    await smiInput.click();
    await smiInput.fill('export team contacts');

    const countBadge = page.locator('span.silent-mi-count');
    await expect(countBadge).toContainText('0', { timeout: 3000 });
    const anyActive = page.locator('[data-silent-mi-active="true"]');
    await expect(anyActive).toHaveCount(0);
  });

  test('Scenario 15: Responsive desktop button resolution over hidden mobile duplicate', async ({ page }) => {
    await page.goto('/#/billing');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('Manage Billing');

    const desktopBtn = page.locator('#btn-billing-desktop');
    const mobileBtn = page.locator('#btn-billing-mobile');

    // Invariant: Desktop visible button is active, hidden mobile button is never activated
    await expect(desktopBtn).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });
    await expect(mobileBtn).not.toHaveAttribute('data-silent-mi-active', 'true');
  });

  test('Scenario 16: Strict UGC isolation ([data-mi-untrusted])', async ({ page }) => {
    await page.goto('/#/privacy');

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('personal email');

    // Official clause is found
    const officialClause = page.locator('#clause-privacy-email');
    await expect(officialClause).toBeVisible();

    // UGC container text is never touched by CSS highlights
    const ugcContainer = page.locator('#ugc-comments');
    const ugcMarks = ugcContainer.locator('mark');
    await expect(ugcMarks).toHaveCount(0);

    // Switch to viewer role, verify spoofed button inside UGC is ignored
    const roleSelect = page.locator('#role-switcher');
    await roleSelect.selectOption('viewer');
    await smiInput.click();
    await smiInput.fill('delete workspace');

    // Invariant: 0 matches, viewer cannot match spoofed UGC delete button
    const countBadge = page.locator('span.silent-mi-count');
    await expect(countBadge).toContainText('0', { timeout: 3000 });
  });

  test('Scenario 17: Zero-reload onNavigate SPA transitions', async ({ page }) => {
    await page.goto('/#/general');

    // Set up window reload detection flag
    await page.evaluate(() => {
      (window as unknown as { __e2eDidNotReload: boolean }).__e2eDidNotReload = true;
    });

    const smiInput = page.locator('input.silent-mi-input');
    await smiInput.click();
    await smiInput.fill('Configure Webhooks');

    const secTrigger = page.locator('#sec-trigger');
    await expect(secTrigger).toHaveAttribute('data-silent-mi-active', 'true', { timeout: 4000 });

    // Verify hash changed to #/security
    await expect(page).toHaveURL(/.*#\/security/);

    // Verify page did NOT reload
    const preservedFlag = await page.evaluate(() => (window as unknown as { __e2eDidNotReload: boolean }).__e2eDidNotReload);
    expect(preservedFlag).toBe(true);
  });

  test('Scenario 18: Client ONNX Embedder activation and RAM telemetry', async ({ page }) => {
    // Navigate with ?onnx=true&consent=eager to activate ONNX embedder in demo workbench
    await page.goto('/?onnx=true&consent=eager#/general');

    const consentStatus = page.locator('#consent-status');
    await expect(consentStatus).toContainText('AI: Consented', { timeout: 10000 });

    const ramBadge = page.locator('#ram-telemetry');
    await expect(ramBadge).toBeVisible();
    await expect(ramBadge).toContainText('ONNX', { timeout: 10000 });
  });

});

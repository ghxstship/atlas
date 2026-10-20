// A59 visual review: copies the screenshot behind each finding into legal/qa/visual-review/evidence/,
// downscaled and compressed so it can be committed beside the finding. Sources are paths under
// shots/ (gitignored); a missing source is reported and skipped.
//   node evidence.mjs
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SHOTS, loadSharp } from "./lib.mjs";

const sharp = loadSharp();
const OUT = join(ROOT, "legal/qa/visual-review/evidence");
mkdirSync(OUT, { recursive: true });

/** finding id: [source under shots/, ...] */
const EVIDENCE = {
  "001": ["states/atlas-phone-shell/02-menu_drawer.phone.dark.jpg"],
  "002": [
    "states/atlas-create-project/03-more_fields.desktop.light.jpg",
    "states/atlas-create-forms/05-shifts_create.phone.light.jpg",
  ],
  "003": ["atlas/owner/028-demo_productions_p_NWS_procurement.desktop.light.jpg"],
  "004": [
    "atlas/owner/005-demo_productions_inbox.phone.light.jpg",
    "atlas/owner/019-demo_productions_p_NWS_advancing.phone.light.jpg",
  ],
  "005": ["probe/numbering-phone-small.jpg"],
  "006": ["atlas/owner/005-demo_productions_inbox.desktop.light.jpg"],
  "007": ["atlas/owner/199-demo_productions_settings_numbering.desktop.light.jpg"],
  "008": ["atlas/owner/040-demo_productions_work_all_records.desktop.light.jpg"],
  "009": ["atlas/owner/072-demo_productions_assets_maintenance.phone.light.jpg"],
  "010": ["states/atlas-create-forms/01-incidents_create.desktop.light.jpg"],
  "011": [
    "atlas/owner/096-demo_productions_people_offers.desktop.light.jpg",
    "atlas/owner/076-demo_productions_credentials_issued.desktop.light.jpg",
  ],
  "012": [
    "atlas/owner/124-demo_productions_finance_expenses.desktop.light.jpg",
    "atlas/owner/126-demo_productions_finance_invoices.desktop.light.jpg",
    "atlas/owner/084-demo_productions_safety_dispatch_board.desktop.light.jpg",
  ],
  "013": [
    "atlas/owner/008-demo_productions_projects_all.phone.light.jpg",
    "atlas/owner/022-demo_productions_p_NWS_assets.phone.light.jpg",
  ],
  "014": [
    "atlas/viewer/000-demo_productions_home.desktop.light.jpg",
    "atlas/viewer/006-demo_productions_my_work.desktop.light.jpg",
    "atlas/viewer/008-demo_productions_projects_all.desktop.light.jpg",
    "atlas/field/000-demo_productions_home.phone.light.jpg",
  ],
  "015": [
    "states/atlas-command-menu/03-type_incident.desktop.light.jpg",
    "states/atlas-command-menu/04-type_action.desktop.light.jpg",
  ],
  "016": ["states/atlas-peek/01-peek_record.desktop.light.jpg"],
  "017": [
    "atlas/owner/156-demo_productions_reports_gate_readiness.desktop.light.jpg",
    "atlas/owner/044-demo_productions_work_recurring.desktop.light.jpg",
    "atlas/owner/179-demo_productions_activity_audit_log.desktop.light.jpg",
  ],
  "018": ["atlas/owner/182-demo_productions_settings_general.desktop.light.jpg"],
  "019": ["states/atlas-settings-security/06-break_glass_reason.desktop.light.jpg"],
  "020": [
    "atlas/partner/007-demo_partner_settings_partner.desktop.light.jpg",
    "atlas/partner/000-demo_partner_home.desktop.light.jpg",
  ],
  "021": [
    "gateway/vendor/035-work_engagements_ENG_01J8000000E008000000025102_deliveries.desktop.light.jpg",
  ],
  "022": ["compass-field-run1/field-light-clock-in.png"],
  "023": ["atlas/owner/013-demo_productions_p_NWS_overview.phone.light.jpg"],
  "024": ["states/atlas-anonymous/05-invite_bad_token.desktop.light.jpg"],
  "025": [
    "states/gateway-anonymous/03-sign_up.phone.dark.jpg",
    "states/atlas-anonymous/06-legal.desktop.light.jpg",
  ],
  "026": ["compass/crew/crew-dark-timesheets.png", "compass/crew/crew-dark-schedule.png"],
  "027": ["atlas/owner/151-demo_productions_knowledge_feed.desktop.light.jpg"],
  "028": ["compass-field-run1/field-dark-schedule.png"],
  "029": ["states/atlas-documents-pdf/02-invoice_peek.desktop.light.jpg"],
  "030": ["atlas/owner/013-demo_productions_p_NWS_overview.desktop.light.jpg"],
  "031": ["compass-field-run1/field-light-settings.png", "compass/probe.png"],
  "033": [
    "gateway/client/032-work_engagements_ENG_01M5B9WSKBFT1TPT7SGV5F37B8_overview.desktop.light.jpg",
    "gateway/sponsor/032-work_engagements_ENG_01M5B9X5FCE2VV5VM1EKYA7DX4_overview.desktop.light.jpg",
    "gateway/client/028-settings_payout_and_tax.desktop.light.jpg",
  ],
  "032": [
    "states/atlas-settings-billing/03-usage.desktop.light.jpg",
    "atlas/owner/195-demo_productions_settings_templates.desktop.light.jpg",
    "atlas/owner/011-demo_productions_projects_templates.desktop.light.jpg",
  ],
};

let n = 0;
for (const [id, sources] of Object.entries(EVIDENCE)) {
  for (const [i, src] of sources.entries()) {
    const from = join(SHOTS, src);
    if (!existsSync(from)) {
      console.log(`missing: ${src}`);
      continue;
    }
    const meta = await sharp(from).metadata();
    const phone = meta.width <= 400 || (meta.width > 1100 && meta.height > 2 * meta.width);
    const width = phone ? Math.min(meta.width, 390) : Math.min(meta.width, 1000);
    // Probe images are already whole-page overviews; keep them uncropped.
    const height = src.startsWith("probe/")
      ? meta.height
      : Math.min(meta.height, Math.round(meta.width * (phone ? 2.4 : 1.6)));
    await sharp(from)
      .extract({ left: 0, top: 0, width: meta.width, height })
      .resize({ width })
      .jpeg({ quality: 62, mozjpeg: true })
      .toFile(join(OUT, `A59-${id}-${i + 1}.jpg`));
    n += 1;
  }
}
console.log(`${n} evidence images in ${OUT}`);

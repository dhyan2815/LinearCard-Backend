# LinearCard PoC — Demo Day Validation Checklist

Run this top-to-bottom the evening before the presentation.
All items must be ✅ before entering the meeting.

## Block 1: Environment
- [ ] `npm run dev` starts without errors
- [ ] `node tests/smoke-test.mjs` — all 4 tests show ✅ PASS
- [ ] Android test phone is logged into the Gmail address in Google Wallet test accounts
- [ ] Waha is reachable: `curl {WAHA_BASE_URL}/api/sessions` returns session list

## Block 2: OTP Flow
- [ ] Open landing page → click "Experience the Demo"
- [ ] Enter your real phone number (E.164 format: +91...) → click "Send OTP"
- [ ] Receive WhatsApp message within 60 seconds with a 4-digit code
- [ ] Enter the code → check DPDP consent box → click "Verify & Generate Pass"
- [ ] Success screen appears with QR code
- [ ] Within 30 seconds, receive WhatsApp message with "Add to Google Wallet" link

## Block 3: Pass Save (Android)
- [ ] Scan QR on Android test phone OR tap the WhatsApp link
- [ ] Google Wallet opens natively (not browser) — IAB breakout confirmed
- [ ] Click "Add to Google Wallet" → confirm → pass saved
- [ ] Verify pass shows: correct card title, member name, background color, QR code

## Block 4: Live Update + Push Notification
- [ ] In Dashboard → Issue a pass for a new member
- [ ] Note the Pass ID in Session Passes panel → click to open in Manage Live tab
- [ ] Enter new balance (e.g. "250 Pts") + push notification text + customer phone
- [ ] Click "Push Live Update"
- [ ] On Android phone: Google Wallet pass shows "250 Pts" within ~30 seconds
- [ ] On Android phone: Google Wallet lock-screen notification fires
- [ ] On Android phone: WhatsApp receipt received within 2 seconds

## Block 5: Staff Scanner
- [ ] Open `http://localhost:3000/scan` on mobile browser (or type URL)
- [ ] Enter the barcode value from a previously issued pass
- [ ] Click Validate → member name and balance displayed
- [ ] Enter redemption amount → click Redeem
- [ ] Success confirmation shown
- [ ] WhatsApp receipt fires on registered phone

## Block 6: Demo Dry-Run
- [ ] Run full Phase 7 script from LinearCard_PoC_Execution_Guide.md
- [ ] Total flow takes < 5 minutes
- [ ] All screens transition smoothly
- [ ] No console errors visible during the flow

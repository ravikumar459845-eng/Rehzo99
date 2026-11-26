# REHZO 99 – Find Your Stay

Mobile-first room, PG, hostel and flat discovery and booking platform.

## Implemented
- Responsive mobile and desktop website with room search and country/currency/type filters.
- Supabase email/password sign-up, login, logout and refreshable sessions.
- Owner profiles and live room listings.
- Up to 3 WebP photos per listing, maximum 3 MB each.
- Owner phone/email and exact room GPS stored in separate private tables.
- Nearby search using approximate listing coordinates; exact directions are gated by final booking.
- Room GPS capture is required before a new listing can be published; exact coordinates remain private.
- Booking request → owner accept/reject → seeker final confirmation.
- A database-level unique partial index ensures only one final-confirmed booking per listing; the first successful confirmation wins.
- System-generated 12-digit TRL numbers; listings become booked after confirmation.
- Owner dashboard, discount duration, booking history and support tickets.
- Protected admin view, available only to explicitly provisioned admin users.
- Booking expiry after 24 months and a daily cleanup job for old booking history.
- Terms, Privacy and Support pages.

## Supabase
Project ref: fbjclsnxcxorkzbcgelv (Free plan selected). Browser configuration contains only the publishable key. Never expose a service-role key in client code.

## Remaining setup before broad public launch
- Google OAuth and phone/SMS OTP require provider credentials and configuration.
- Email delivery/confirmation should be tested and a custom SMTP provider configured if public email confirmation is required.
- Admin account must be explicitly assigned in public.admin_users after the intended account is registered and verified.
- Real two-account end-to-end booking, photo upload and mobile-device tests remain to be performed.
- Country/GPS consistency and owner identity verification need a production-grade verification provider.
- No payments are configured. Do not accept payment through the app.
- The app should receive a full security and privacy review before large-scale public launch.

## Product rules
Room types: Single Room, 1 RK, 2 BHK, 3 BHK, PG, Flat, Hostel, Shared.
Suitable for: Anyone, Students, Family, Worker.
Amenities: Wi-Fi, AC, Parking, Kitchen, Furnished, Geyser, Lift, Power Backup.
No daily/weekly booking. No video uploads. No payment provider until deliberately configured and verified.

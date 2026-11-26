# REHZO 99 – Find Your Stay

Mobile-first room, PG, hostel and flat discovery platform.

## Included in this first front-end commit
- Responsive landing page and mobile navigation.
- Search field and room type, country and currency filters.
- Browser location permission requested only after a user taps Find Room.
- Login and owner-listing preview modals.
- Terms, Privacy and Support pages.
- Web app manifest, favicon and robots.txt.
- No fabricated listings or fake booking records.

## Backend is not connected
Authentication, owner profiles, listing uploads, nearby listing matching, booking workflow, immutable 12-digit TRL generation, contact reveal, discounts, admin dashboard, tickets, notifications, database security and analytics are NOT live. The interface explicitly labels these as pending rather than pretending they work.

## Next implementation stages
1. Supabase Auth, database, Storage and strict Row Level Security.
2. Owner/user profiles and verified country-aware listings.
3. GPS capture, nearby search, local currency, phone code and timezone.
4. Booking request → owner accept/reject → user's final confirmation; first final confirmation wins atomically.
5. Unique immutable 12-digit TRL number after final confirmation, valid for 24 months.
6. Reveal contact details only after final confirmation.
7. Discount expiry, owner dashboard, protected admin panel, complaints, tickets, notifications and audit logs.
8. End-to-end security and mobile/desktop tests before public launch.

## Run and deploy
Static site; no build command required. Import ravikumar459845-eng/Rehzo99 into Vercel with the repository root as project root. After deployment, configure the real production canonical URL and sitemap. Do not submit a guessed domain to Search Console.

## Product rules to preserve
Room types: Single Room, 1 RK, 2 BHK, 3 BHK, PG, Flat, Hostel, Shared.
Suitable for: Anyone, Students, Family, Worker.
Amenities: Wi-Fi, AC, Parking, Kitchen, Furnished, Geyser, Lift, Power Backup.
Maximum 3 WebP photos per listing. No video uploads. No payment provider until deliberately configured and verified.

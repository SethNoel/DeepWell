# Deepwell Civic Network

The app stores citizen profiles in the `citizens` collection and hashed, expiring sign-in tokens in the `authTokens` collection. Each browser tab stores its own sign-in token in tab-scoped session storage, so multiple tabs can stay signed into different citizen accounts. Passwords are stored as bcrypt hashes. Citizen registration currently collects a display name, email, and level.

After signing in, citizens can use the Resources tab to post and close offers or requests for power, water, and food; Network to post community updates and request help; Health Watch to submit anonymous symptom and supply reports and view aggregated trends; and Citizens to search the public name-and-level directory. These features use the `resourceListings`, `communityPosts`, `helpRequests`, and `healthReports` collections. Health reports do not store account IDs or names and should be treated as community signals, not diagnoses.

## Demo data, map, and notifications

Run `npm run seed:demo` to add 100 fictional citizens, 48 resource listings, 24 community posts, 12 help requests, 42 anonymous health reports, and example notifications. The seeder is idempotent and only inserts records with its own `demoSeedId`; it does not delete or overwrite existing records. Demo accounts use reserved `.invalid` email addresses, random inaccessible password hashes, and cannot sign in. The Citizens directory paginates results, marks seeded residents as `DEMO`, and searches across the full database.

The Network tab includes a schematic level map with selectable floors and resource, help-request, and anonymous-health layers. It intentionally shows floor-level aggregates and relay stations rather than precise citizen locations. The notification bell shows recent community activity, supports per-notification and bulk read state, and refreshes periodically while signed in. Notifications are stored in the `notifications` collection.

The Chats tab uses Socket.IO for live online status and one-to-one messaging. Presence and the latest 100 messages per conversation are held in server memory only; they are not saved to MongoDB and are cleared when the server restarts. Demo seed accounts cannot sign in or receive chats. Each tab has its own citizen identity, so separate tabs in the same browser can be signed into different accounts.

For production, set `NODE_ENV=production` and serve the app over HTTPS.

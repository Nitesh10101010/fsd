# Campus Sports Facility & Equipment Booking System

A full-stack starter implementation based on the submitted proposal.

## Stack
- React + Vite + Tailwind CSS
- Node.js + Express
- PostgreSQL (`pg`, parameterized SQL)
- JWT authentication + bcrypt
- Database-enforced booking uniqueness and transactional inventory reservation

## Important
This project creates a **new database schema and sample records** because no existing SQL backup was supplied. It does not claim to restore existing college data. Review `database/schema.sql` before running it.

## Requirements
- Node.js 20+
- PostgreSQL 14+
- npm

## Setup

### 1. Create database and load schema
```bash
createdb campus_sports_booking
psql -d campus_sports_booking -f database/schema.sql
```

### 2. Backend
```bash
cd backend
cp .env.example .env
# Set DATABASE_URL and JWT_SECRET in .env
npm install
npm run dev
```
API runs at `http://localhost:5000`.

### 3. Frontend
In another terminal:
```bash
cd frontend
npm install
npm run dev
```
Open the Vite URL shown in the terminal (normally `http://localhost:5173`).

## Create an administrator
Register normally through the app, then promote that account using PostgreSQL:
```sql
UPDATE users SET role = 'admin' WHERE email = 'your-email@example.com';
```
Do not expose this operation in public registration.

## Demo data
`database/schema.sql` seeds facilities, equipment and future time slots. It intentionally does not seed users or plaintext passwords. Register two users to test bookings.

## Concurrency guarantee
`bookings` has a partial unique index:
```sql
CREATE UNIQUE INDEX uq_one_active_booking_per_slot
ON bookings(slot_id) WHERE status = 'confirmed';
```
The booking service also locks the target slot with `SELECT ... FOR UPDATE`, checks maintenance, reserves equipment and creates the booking inside one transaction. A competing request receives HTTP 409. The database index is the final safety net even if another code path forgets the lock.

## Run the concurrency test
1. Start backend and database.
2. Register two users via `/api/auth/register`.
3. Put their JWTs in `USER1_TOKEN` and `USER2_TOKEN`.
4. Set `SLOT_ID` to an open future slot ID.
```bash
cd backend
USER1_TOKEN=... USER2_TOKEN=... SLOT_ID=1 npm run test:concurrency
```
Exactly one request should succeed and one should return 409. The test script sends both requests concurrently.

## API overview
- `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`
- `GET /api/facilities`, `GET /api/facilities/:id/slots`
- `GET /api/equipment`
- `POST /api/bookings`, `GET /api/bookings/my`, `PATCH /api/bookings/:id/cancel`
- Admin: `GET /api/admin/summary`, CRUD facilities/equipment, maintenance and booking list

## Notes / next steps
- Configure campus-specific facility names, time windows, cancellation policy and user verification.
- Add email notifications and audit logging if required by the institution.
- Use HTTPS, strong secrets, database backups and production deployment settings before launch.

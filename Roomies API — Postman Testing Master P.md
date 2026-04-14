# Roomies API — Postman Testing Master Plan

## Part 1 — Postman Setup (New UI, Linux)

### What changed in the latest Postman (2025–2026)

The UI you will see on your Linux install has these key differences from older versions and from ThunderClient:

- **Unified workbench** — the left sidebar has Collections, Environments, History. Everything opens as a tab in the
  center panel.
- **Variables redesigned** — there is now **one value per variable** (no more "initial value" vs "current value"
  confusion). Variables save locally by default and are private. You toggle a switch next to each variable to share it.
- **Mark as sensitive** — tick this on tokens and secrets so Postman masks the value in the UI and warns you before
  syncing.
- **Scripts tab** — Pre-request and Post-response scripts are now under a single **Scripts** tab inside each request
  (not separate tabs labeled Pre-request Script / Tests like the old UI).
- **Console** — bottom footer bar, click **Console** to see every request/response raw. Essential for debugging.
- **Autosave** — everything autosaves. You do not need to press Ctrl+S.

---

### Step 1 — Create the Environment

1. In the left sidebar click **Environments**.
2. Click **+** (Create Environment).
3. Name it `Roomies Local`.
4. Add every variable below. Leave the value blank for now — the scripts will fill them automatically.

| Variable                 | Initial Value                  | Sensitive? |
| ------------------------ | ------------------------------ | ---------- |
| `baseUrl`                | `http://localhost:3000/api/v1` | No         |
| `student1AccessToken`    |                                | Yes        |
| `student1RefreshToken`   |                                | Yes        |
| `student1Id`             |                                | No         |
| `student2AccessToken`    |                                | Yes        |
| `student2RefreshToken`   |                                | Yes        |
| `student2Id`             |                                | No         |
| `pgOwner1AccessToken`    |                                | Yes        |
| `pgOwner1RefreshToken`   |                                | Yes        |
| `pgOwner1Id`             |                                | No         |
| `pgOwner2AccessToken`    |                                | Yes        |
| `pgOwner2RefreshToken`   |                                | Yes        |
| `pgOwner2Id`             |                                | No         |
| `pgOwner3AccessToken`    |                                | Yes        |
| `pgOwner3RefreshToken`   |                                | Yes        |
| `pgOwner3Id`             |                                | No         |
| `property1Id`            |                                | No         |
| `property2Id`            |                                | No         |
| `listing1Id`             |                                | No         |
| `listing2Id`             |                                | No         |
| `listing3Id`             |                                | No         |
| `listing4Id`             |                                | No         |
| `interestRequest1Id`     |                                | No         |
| `interestRequest2Id`     |                                | No         |
| `connection1Id`          |                                | No         |
| `connection2Id`          |                                | No         |
| `rating1Id`              |                                | No         |
| `report1Id`              |                                | No         |
| `verificationRequest1Id` |                                | No         |
| `verificationRequest2Id` |                                | No         |
| `verificationRequest3Id` |                                | No         |

5. Click **Save**.
6. In the top-right corner of Postman, click the environment dropdown and select **Roomies Local** to activate it.

---

### Step 2 — Create the Collection

1. Left sidebar → **Collections** → click **+** → **Blank collection**.
2. Name it `Roomies API — Full E2E Test Suite`.
3. Click the collection name → **Scripts** tab → paste this in the **Pre-request** section:

```javascript
// Ensures baseUrl is always available even if the environment variable is missing
if (!pm.environment.get("baseUrl")) {
	pm.environment.set("baseUrl", "http://localhost:3000/api/v1");
}
```

---

### How to use Bearer tokens (recommended over cookies for Postman)

Your server checks for the header `X-Client-Transport: bearer` to return tokens in the response body instead of cookies
only. Add this as a **collection-level header**:

1. Click the collection name → **Headers** tab.
2. Add: `X-Client-Transport` → `bearer`.

This applies to every request in the collection automatically. The post-response scripts below will capture the tokens
from the JSON body.

---

### How to read the Scripts in each request below

Every request that returns tokens has a **Scripts → Post-response** script. In the new Postman UI:

1. Open the request.
2. Click the **Scripts** tab.
3. Paste the script into the **Post-response** section.

---

## Part 2 — Fake Test Data

### Users

| User       | Email                             | Password   | Role     | Full Name     | Business Name        |
| ---------- | --------------------------------- | ---------- | -------- | ------------- | -------------------- |
| Student 1  | `arjun.sharma@student.iitb.ac.in` | `Test1234` | student  | Arjun Sharma  | —                    |
| Student 2  | `priya.nair@student.bits.ac.in`   | `Test1234` | student  | Priya Nair    | —                    |
| PG Owner 1 | `ravi.mehta@gmail.com`            | `Test1234` | pg_owner | Ravi Mehta    | Mehta PG House       |
| PG Owner 2 | `sunita.kapoor@gmail.com`         | `Test1234` | pg_owner | Sunita Kapoor | Kapoor Ladies Hostel |
| PG Owner 3 | `deepak.joshi@gmail.com`          | `Test1234` | pg_owner | Deepak Joshi  | Joshi Paying Guest   |

---

## Part 3 — Collection Folder Structure

```
Roomies API — Full E2E Test Suite
│
├── 00 - Health Check
├── 01 - Auth
│   ├── Happy Path
│   └── Error Cases
├── 02 - Student Profiles
│   ├── Happy Path
│   └── Error Cases
├── 03 - PG Owner Profiles
│   ├── Happy Path
│   └── Error Cases
├── 04 - Verification (Admin)
│   ├── Happy Path
│   └── Error Cases
├── 05 - Properties
│   ├── Happy Path
│   └── Error Cases
├── 06 - Listings
│   ├── Happy Path
│   └── Error Cases
├── 07 - Interest Requests
│   ├── Happy Path
│   └── Error Cases
├── 08 - Connections
│   ├── Happy Path
│   └── Error Cases
├── 09 - Ratings
│   ├── Happy Path
│   └── Error Cases
└── 10 - Reports (Admin)
    ├── Happy Path
    └── Error Cases
```

To create a folder: right-click the collection → **Add folder**. Nest Error Cases inside each parent folder the same
way.

---

## Part 4 — All Requests, Folder by Folder

---

### 00 - Health Check

**GET Health**

- URL: `{{baseUrl}}/health`
- No headers, no body.
- Scripts → Post-response:

```javascript
pm.test("Status is 200", () => pm.response.to.have.status(200));
pm.test("All services ok", () => {
	const body = pm.response.json();
	pm.expect(body.status).to.eql("ok");
	pm.expect(body.services.database).to.eql("ok");
	pm.expect(body.services.redis).to.eql("ok");
});
```

---

### 01 - Auth → Happy Path

**[1.1] Register Student 1**

- Method: POST
- URL: `{{baseUrl}}/auth/register`
- Body → raw → JSON:

```json
{
	"email": "arjun.sharma@student.iitb.ac.in",
	"password": "Test1234",
	"role": "student",
	"fullName": "Arjun Sharma"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.test("Returns tokens", () => {
	pm.expect(body.data.accessToken).to.be.a("string");
	pm.expect(body.data.refreshToken).to.be.a("string");
});
pm.environment.set("student1AccessToken", body.data.accessToken);
pm.environment.set("student1RefreshToken", body.data.refreshToken);
pm.environment.set("student1Id", body.data.user.userId);
```

---

**[1.2] Register Student 2**

- Method: POST
- URL: `{{baseUrl}}/auth/register`
- Body:

```json
{
	"email": "priya.nair@student.bits.ac.in",
	"password": "Test1234",
	"role": "student",
	"fullName": "Priya Nair"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("student2AccessToken", body.data.accessToken);
pm.environment.set("student2RefreshToken", body.data.refreshToken);
pm.environment.set("student2Id", body.data.user.userId);
```

---

**[1.3] Register PG Owner 1**

- Method: POST
- URL: `{{baseUrl}}/auth/register`
- Body:

```json
{
	"email": "ravi.mehta@gmail.com",
	"password": "Test1234",
	"role": "pg_owner",
	"fullName": "Ravi Mehta",
	"businessName": "Mehta PG House"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("pgOwner1AccessToken", body.data.accessToken);
pm.environment.set("pgOwner1RefreshToken", body.data.refreshToken);
pm.environment.set("pgOwner1Id", body.data.user.userId);
```

---

**[1.4] Register PG Owner 2**

- Method: POST
- URL: `{{baseUrl}}/auth/register`
- Body:

```json
{
	"email": "sunita.kapoor@gmail.com",
	"password": "Test1234",
	"role": "pg_owner",
	"fullName": "Sunita Kapoor",
	"businessName": "Kapoor Ladies Hostel"
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("pgOwner2AccessToken", body.data.accessToken);
pm.environment.set("pgOwner2RefreshToken", body.data.refreshToken);
pm.environment.set("pgOwner2Id", body.data.user.userId);
```

---

**[1.5] Register PG Owner 3**

- Method: POST
- URL: `{{baseUrl}}/auth/register`
- Body:

```json
{
	"email": "deepak.joshi@gmail.com",
	"password": "Test1234",
	"role": "pg_owner",
	"fullName": "Deepak Joshi",
	"businessName": "Joshi Paying Guest"
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("pgOwner3AccessToken", body.data.accessToken);
pm.environment.set("pgOwner3RefreshToken", body.data.refreshToken);
pm.environment.set("pgOwner3Id", body.data.user.userId);
```

---

**[1.6] Login Student 1**

- Method: POST
- URL: `{{baseUrl}}/auth/login`
- Body:

```json
{
	"email": "arjun.sharma@student.iitb.ac.in",
	"password": "Test1234"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.environment.set("student1AccessToken", body.data.accessToken);
pm.environment.set("student1RefreshToken", body.data.refreshToken);
```

---

**[1.7] Get Me — Student 1**

- Method: GET
- URL: `{{baseUrl}}/auth/me`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Returns user object", () => {
	const body = pm.response.json();
	pm.expect(body.data.userId).to.be.a("string");
	pm.expect(body.data.roles).to.include("student");
});
```

---

**[1.8] Refresh Token — Student 1**

- Method: POST
- URL: `{{baseUrl}}/auth/refresh`
- Body:

```json
{
	"refreshToken": "{{student1RefreshToken}}"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.environment.set("student1AccessToken", body.data.accessToken);
pm.environment.set("student1RefreshToken", body.data.refreshToken);
```

---

**[1.9] List Sessions — Student 1**

- Method: GET
- URL: `{{baseUrl}}/auth/sessions`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Returns array", () => pm.expect(pm.response.json().data).to.be.an("array"));
```

---

**[1.10] Send OTP — Student 1**

> Note: Student 1 used a non-institution email so they are not auto-verified. Use this to verify them. Check your
> Ethereal Mail preview URL in the server terminal logs after sending.

- Method: POST
- URL: `{{baseUrl}}/auth/otp/send`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- No body.
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
```

---

**[1.11] Verify OTP — Student 1**

> After sending, check your running server terminal. You will see a log line like
> `previewUrl: "https://ethereal.email/message/..."`. Open that URL in a browser to see the OTP code.

- Method: POST
- URL: `{{baseUrl}}/auth/otp/verify`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"otp": "PASTE_OTP_FROM_ETHEREAL_HERE"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
```

---

### 01 - Auth → Error Cases

**[1.E1] Register with duplicate email**

- POST `{{baseUrl}}/auth/register`
- Body: same email as Student 1 above.
- Scripts → Post-response:

```javascript
pm.test("Status 409 conflict", () => pm.response.to.have.status(409));
```

**[1.E2] Login with wrong password**

- POST `{{baseUrl}}/auth/login`
- Body: `{ "email": "arjun.sharma@student.iitb.ac.in", "password": "wrongpass" }`
- Scripts → Post-response:

```javascript
pm.test("Status 401", () => pm.response.to.have.status(401));
```

**[1.E3] Register pg_owner without businessName**

- POST `{{baseUrl}}/auth/register`
- Body: `{ "email": "test@test.com", "password": "Test1234", "role": "pg_owner", "fullName": "Test" }`
- Scripts → Post-response:

```javascript
pm.test("Status 400", () => pm.response.to.have.status(400));
```

**[1.E4] Access protected route without token**

- GET `{{baseUrl}}/auth/me`
- No Authorization header.
- Scripts → Post-response:

```javascript
pm.test("Status 401", () => pm.response.to.have.status(401));
```

**[1.E5] Use expired / invalid token**

- GET `{{baseUrl}}/auth/me`
- Headers: `Authorization: Bearer thisisnotavalidtoken`
- Scripts → Post-response:

```javascript
pm.test("Status 401", () => pm.response.to.have.status(401));
```

---

### 02 - Student Profiles → Happy Path

**[2.1] Get Student 1 Profile (self)**

- GET `{{baseUrl}}/students/{{student1Id}}/profile`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Returns profile", () => {
	const data = pm.response.json().data;
	pm.expect(data.full_name).to.eql("Arjun Sharma");
	pm.expect(data.email).to.be.a("string"); // self view includes email
});
```

**[2.2] Get Student 1 Profile (as Student 2 — no email visible)**

- GET `{{baseUrl}}/students/{{student1Id}}/profile`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Email hidden for non-owner", () => {
	const data = pm.response.json().data;
	pm.expect(data.email).to.be.null;
});
```

**[2.3] Update Student 1 Profile**

- PUT `{{baseUrl}}/students/{{student1Id}}/profile`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"bio": "Final year CSE student at IIT Bombay. Looking for a clean and quiet room near campus.",
	"course": "B.Tech Computer Science",
	"yearOfStudy": 4,
	"gender": "male"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Bio updated", () => {
	pm.expect(pm.response.json().data.bio).to.include("IIT Bombay");
});
```

**[2.4] Update Student 2 Profile**

- PUT `{{baseUrl}}/students/{{student2Id}}/profile`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Body:

```json
{
	"bio": "Second year ECE at BITS Pilani. Non-smoker, vegetarian, looking for female-only PG.",
	"course": "B.E. Electronics",
	"yearOfStudy": 2,
	"gender": "female"
}
```

---

### 02 - Student Profiles → Error Cases

**[2.E1] Update another student's profile**

- PUT `{{baseUrl}}/students/{{student2Id}}/profile`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "bio": "Hacked bio" }`
- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

**[2.E2] Get non-existent profile**

- GET `{{baseUrl}}/students/00000000-0000-0000-0000-000000000000/profile`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 404", () => pm.response.to.have.status(404));
```

---

### 03 - PG Owner Profiles → Happy Path

**[3.1] Get PG Owner 1 Profile (self)**

- GET `{{baseUrl}}/pg-owners/{{pgOwner1Id}}/profile`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("verification_status is unverified", () => {
	pm.expect(pm.response.json().data.verification_status).to.eql("unverified");
});
```

**[3.2] Update PG Owner 1 Profile**

- PUT `{{baseUrl}}/pg-owners/{{pgOwner1Id}}/profile`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"businessDescription": "Clean, well-maintained PG in Koramangala with 24hr water and WiFi.",
	"businessPhone": "9876543210",
	"operatingSince": 2019
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
```

**[3.3] Update PG Owner 2 Profile**

- PUT `{{baseUrl}}/pg-owners/{{pgOwner2Id}}/profile`
- Headers: `Authorization: Bearer {{pgOwner2AccessToken}}`
- Body:

```json
{
	"businessDescription": "Ladies-only hostel in Indiranagar with strict curfew and home food.",
	"businessPhone": "9123456780",
	"operatingSince": 2021
}
```

**[3.4] Update PG Owner 3 Profile**

- PUT `{{baseUrl}}/pg-owners/{{pgOwner3Id}}/profile`
- Headers: `Authorization: Bearer {{pgOwner3AccessToken}}`
- Body:

```json
{
	"businessDescription": "Affordable PG near HSR Layout. Single and double rooms available.",
	"businessPhone": "9988776655",
	"operatingSince": 2020
}
```

---

### 03 - PG Owner Profiles → Error Cases

**[3.E1] Update another owner's profile**

- PUT `{{baseUrl}}/pg-owners/{{pgOwner2Id}}/profile`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body: `{ "businessName": "Hacked" }`
- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

**[3.E2] Student tries to update a PG owner profile**

- PUT `{{baseUrl}}/pg-owners/{{pgOwner1Id}}/profile`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "businessName": "Hacked" }`
- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

---

### 04 - Verification (Admin) → Happy Path

> You need an admin user. The quickest approach for local dev: connect to your DB and run:
>
> ```sql
> INSERT INTO user_roles (user_id, role_name)
> SELECT user_id, 'admin' FROM users WHERE email = 'arjun.sharma@student.iitb.ac.in';
> ```
>
> Then re-login as Student 1 to get a fresh token that includes the admin role.

**[4.1] PG Owner 1 Submits Verification Document**

- POST `{{baseUrl}}/pg-owners/{{pgOwner1Id}}/documents`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"documentType": "owner_id",
	"documentUrl": "https://example.com/fake-aadhaar-ravi.pdf"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("verificationRequest1Id", body.data.request_id);
```

**[4.2] PG Owner 2 Submits Verification Document**

- POST `{{baseUrl}}/pg-owners/{{pgOwner2Id}}/documents`
- Headers: `Authorization: Bearer {{pgOwner2AccessToken}}`
- Body:

```json
{
	"documentType": "rental_agreement",
	"documentUrl": "https://example.com/fake-agreement-sunita.pdf"
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("verificationRequest2Id", body.data.request_id);
```

**[4.3] PG Owner 3 Submits Verification Document**

- POST `{{baseUrl}}/pg-owners/{{pgOwner3Id}}/documents`
- Headers: `Authorization: Bearer {{pgOwner3AccessToken}}`
- Body:

```json
{
	"documentType": "property_document",
	"documentUrl": "https://example.com/fake-property-deepak.pdf"
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("verificationRequest3Id", body.data.request_id);
```

**[4.4] Admin Views Verification Queue**

> Use Student 1's token here — they now have the admin role from the SQL above.

- GET `{{baseUrl}}/admin/verification-queue`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Queue has items", () => {
	pm.expect(pm.response.json().data.items.length).to.be.above(0);
});
```

**[4.5] Admin Approves PG Owner 1**

- POST `{{baseUrl}}/admin/verification-queue/{{verificationRequest1Id}}/approve`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"adminNotes": "All documents valid. Approved."
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Status is verified", () => {
	pm.expect(pm.response.json().data.status).to.eql("verified");
});
```

**[4.6] Admin Approves PG Owner 2**

- POST `{{baseUrl}}/admin/verification-queue/{{verificationRequest2Id}}/approve`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "adminNotes": "Rental agreement verified." }`

**[4.7] Admin Rejects PG Owner 3**

- POST `{{baseUrl}}/admin/verification-queue/{{verificationRequest3Id}}/reject`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"rejectionReason": "Document is blurry and unreadable. Please upload a clear scan.",
	"adminNotes": "Rejected on first submission."
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Status is rejected", () => {
	pm.expect(pm.response.json().data.status).to.eql("rejected");
});
```

**[4.8] PG Owner 3 Resubmits After Rejection**

- POST `{{baseUrl}}/pg-owners/{{pgOwner3Id}}/documents`
- Headers: `Authorization: Bearer {{pgOwner3AccessToken}}`
- Body:

```json
{
	"documentType": "property_document",
	"documentUrl": "https://example.com/fake-property-deepak-v2-clear.pdf"
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("verificationRequest3Id", body.data.request_id);
```

**[4.9] Admin Approves PG Owner 3 (second attempt)**

- POST `{{baseUrl}}/admin/verification-queue/{{verificationRequest3Id}}/approve`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "adminNotes": "Clear document on second submission. Approved." }`

---

### 04 - Verification → Error Cases

**[4.E1] Non-admin tries to view verification queue**

- GET `{{baseUrl}}/admin/verification-queue`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

**[4.E2] PG Owner submits a second document while one is pending**

> Do this before approving PG Owner 1. Send request 4.1 again to trigger this.

- POST `{{baseUrl}}/pg-owners/{{pgOwner1Id}}/documents`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body: `{ "documentType": "owner_id", "documentUrl": "https://example.com/duplicate.pdf" }`
- Scripts → Post-response:

```javascript
pm.test("Status 409", () => pm.response.to.have.status(409));
```

**[4.E3] Unverified PG Owner tries to create a property**

> PG Owner 3 is still unverified at this point. This should be rejected.

- POST `{{baseUrl}}/properties`
- Headers: `Authorization: Bearer {{pgOwner3AccessToken}}`
- Body:

```json
{
	"propertyName": "Should Fail PG",
	"propertyType": "pg",
	"addressLine": "123 Test Road",
	"city": "Bangalore",
	"amenityIds": []
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

---

### 05 - Properties → Happy Path

> PG Owner 1 and PG Owner 2 are now verified. Use their tokens here.

**[5.1] PG Owner 1 Creates Property 1**

- POST `{{baseUrl}}/properties`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"propertyName": "Mehta PG House — Koramangala",
	"description": "Well-maintained 3-storey PG with 24hr water, power backup, and high-speed WiFi.",
	"propertyType": "pg",
	"addressLine": "47/2, 5th Cross, Koramangala 4th Block",
	"city": "Bangalore",
	"locality": "Koramangala",
	"landmark": "Near Jyoti Nivas College",
	"pincode": "560034",
	"latitude": 12.9352,
	"longitude": 77.6245,
	"houseRules": "No smoking. No alcohol. Gate closes at 11pm.",
	"totalRooms": 12,
	"amenityIds": []
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("property1Id", body.data.property_id);
```

**[5.2] PG Owner 2 Creates Property 2**

- POST `{{baseUrl}}/properties`
- Headers: `Authorization: Bearer {{pgOwner2AccessToken}}`
- Body:

```json
{
	"propertyName": "Kapoor Ladies Hostel — Indiranagar",
	"description": "Ladies-only hostel with home food, laundry, and 24hr security.",
	"propertyType": "hostel",
	"addressLine": "12, 100 Feet Road, Indiranagar",
	"city": "Bangalore",
	"locality": "Indiranagar",
	"landmark": "Behind CMH Hospital",
	"pincode": "560038",
	"latitude": 12.9784,
	"longitude": 77.6408,
	"totalRooms": 20,
	"amenityIds": []
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("property2Id", body.data.property_id);
```

**[5.3] Get Property 1 (as any authenticated user)**

- GET `{{baseUrl}}/properties/{{property1Id}}`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Property name matches", () => {
	pm.expect(pm.response.json().data.property_name).to.include("Mehta");
});
```

**[5.4] PG Owner 1 Lists Their Properties**

- GET `{{baseUrl}}/properties`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("At least 1 property", () => {
	pm.expect(pm.response.json().data.items.length).to.be.above(0);
});
```

**[5.5] PG Owner 1 Updates Property 1**

- PUT `{{baseUrl}}/properties/{{property1Id}}`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"houseRules": "No smoking. No alcohol. Gate closes at 11pm. Guests allowed till 9pm only.",
	"totalRooms": 14
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("totalRooms updated", () => {
	pm.expect(pm.response.json().data.total_rooms).to.eql(14);
});
```

---

### 05 - Properties → Error Cases

**[5.E1] Student tries to create a property**

- POST `{{baseUrl}}/properties`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:
  `{ "propertyName": "Fake PG", "propertyType": "pg", "addressLine": "1 Test St", "city": "Bangalore", "amenityIds": [] }`
- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

**[5.E2] PG Owner 2 tries to update PG Owner 1's property**

- PUT `{{baseUrl}}/properties/{{property1Id}}`
- Headers: `Authorization: Bearer {{pgOwner2AccessToken}}`
- Body: `{ "propertyName": "Hacked" }`
- Scripts → Post-response:

```javascript
pm.test("Status 404", () => pm.response.to.have.status(404));
// The service returns 404 — existence is not leaked to non-owners
```

---

### 06 - Listings → Happy Path

**[6.1] PG Owner 1 Creates pg_room Listing (Listing 1)**

- POST `{{baseUrl}}/listings`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"listingType": "pg_room",
	"propertyId": "{{property1Id}}",
	"title": "Single AC Room in Koramangala PG — Male Only",
	"description": "Attached bathroom, furnished, WiFi included. Ideal for working professionals or students.",
	"rentPerMonth": 12000,
	"depositAmount": 24000,
	"rentIncludesUtilities": true,
	"isNegotiable": false,
	"roomType": "single",
	"bedType": "single_bed",
	"totalCapacity": 1,
	"preferredGender": "male",
	"availableFrom": "2026-05-01",
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" }
	]
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("listing1Id", body.data.listing_id);
pm.test("Rent is in rupees (not paise)", () => {
	pm.expect(body.data.rentPerMonth).to.eql(12000);
});
```

**[6.2] PG Owner 2 Creates hostel_bed Listing (Listing 2)**

- POST `{{baseUrl}}/listings`
- Headers: `Authorization: Bearer {{pgOwner2AccessToken}}`
- Body:

```json
{
	"listingType": "hostel_bed",
	"propertyId": "{{property2Id}}",
	"title": "Bed in Triple Sharing Room — Ladies Hostel Indiranagar",
	"description": "Home food included. CCTV and security guard. Walking distance from metro.",
	"rentPerMonth": 8000,
	"depositAmount": 16000,
	"rentIncludesUtilities": true,
	"isNegotiable": true,
	"roomType": "triple",
	"bedType": "single_bed",
	"totalCapacity": 3,
	"preferredGender": "female",
	"availableFrom": "2026-05-01",
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" },
		{ "preferenceKey": "sleep_schedule", "preferenceValue": "early_bird" }
	]
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("listing2Id", body.data.listing_id);
```

**[6.3] Student 1 Creates student_room Listing (Listing 3)**

- POST `{{baseUrl}}/listings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"listingType": "student_room",
	"title": "Roommate Needed — 2BHK Flat Near IIT Bombay Gate 1",
	"description": "Looking for a clean, studious roommate. 2BHK, sharing one room. No parties.",
	"rentPerMonth": 9000,
	"depositAmount": 18000,
	"rentIncludesUtilities": false,
	"isNegotiable": true,
	"roomType": "double",
	"bedType": "single_bed",
	"totalCapacity": 2,
	"preferredGender": "male",
	"availableFrom": "2026-05-15",
	"addressLine": "Room 204, Shastri Nagar CHS, Powai",
	"city": "Mumbai",
	"locality": "Powai",
	"landmark": "Near IIT Bombay Gate 1",
	"pincode": "400076",
	"latitude": 19.1334,
	"longitude": 72.9133,
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "smoking", "preferenceValue": "non_smoker" },
		{ "preferenceKey": "sleep_schedule", "preferenceValue": "early_bird" }
	]
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("listing3Id", body.data.listing_id);
```

**[6.4] Student 2 Creates student_room Listing (Listing 4)**

- POST `{{baseUrl}}/listings`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Body:

```json
{
	"listingType": "student_room",
	"title": "Female Roommate Wanted — BITS Pilani Off-Campus Housing",
	"description": "Spacious room in 3BHK. Sharing with 2 other girls. Veg household.",
	"rentPerMonth": 7500,
	"depositAmount": 15000,
	"rentIncludesUtilities": false,
	"isNegotiable": false,
	"roomType": "triple",
	"bedType": "single_bed",
	"totalCapacity": 3,
	"preferredGender": "female",
	"availableFrom": "2026-06-01",
	"addressLine": "B-12, Vidhya Vihar Colony",
	"city": "Pilani",
	"locality": "Vidhya Vihar",
	"pincode": "333031",
	"amenityIds": [],
	"preferences": [
		{ "preferenceKey": "food_habit", "preferenceValue": "vegetarian" },
		{ "preferenceKey": "alcohol", "preferenceValue": "not_okay" }
	]
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("listing4Id", body.data.listing_id);
```

**[6.5] Search Listings — by city Bangalore**

- GET `{{baseUrl}}/listings?city=Bangalore`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Results returned", () => {
	pm.expect(pm.response.json().data.items.length).to.be.above(0);
});
pm.test("All results are in Bangalore", () => {
	pm.response.json().data.items.forEach((item) => {
		pm.expect(item.city.toLowerCase()).to.include("bangalore");
	});
});
```

**[6.6] Search Listings — by city Mumbai with rent filter**

- GET `{{baseUrl}}/listings?city=Mumbai&maxRent=10000`
- Headers: `Authorization: Bearer {{student1AccessToken}}`

**[6.7] Get Single Listing**

- GET `{{baseUrl}}/listings/{{listing1Id}}`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Has preferences", () => {
	pm.expect(pm.response.json().data.preferences).to.be.an("array");
});
```

**[6.8] Student 2 Saves Listing 1**

- POST `{{baseUrl}}/listings/{{listing1Id}}/save`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("saved is true", () => pm.expect(pm.response.json().data.saved).to.be.true);
```

**[6.9] Student 2 Views Saved Listings**

- GET `{{baseUrl}}/listings/me/saved`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("At least 1 saved", () => pm.expect(pm.response.json().data.items.length).to.be.above(0));
```

**[6.10] Student 2 Unsaves Listing 1**

- DELETE `{{baseUrl}}/listings/{{listing1Id}}/save`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("saved is false", () => pm.expect(pm.response.json().data.saved).to.be.false);
```

**[6.11] PG Owner 1 Deactivates Listing 1**

- PATCH `{{baseUrl}}/listings/{{listing1Id}}/status`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body: `{ "status": "deactivated" }`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
```

**[6.12] PG Owner 1 Reactivates Listing 1**

- PATCH `{{baseUrl}}/listings/{{listing1Id}}/status`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body: `{ "status": "active" }`

---

### 06 - Listings → Error Cases

**[6.E1] Student tries to create a pg_room listing**

- POST `{{baseUrl}}/listings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:
  `{ "listingType": "pg_room", "propertyId": "{{property1Id}}", "title": "Test", "rentPerMonth": 1000, "depositAmount": 0, "roomType": "single", "totalCapacity": 1, "availableFrom": "2026-05-01", "amenityIds": [] }`
- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

**[6.E2] Create student_room without city**

- POST `{{baseUrl}}/listings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:
  `{ "listingType": "student_room", "title": "No City Listing", "rentPerMonth": 5000, "depositAmount": 0, "roomType": "single", "totalCapacity": 1, "availableFrom": "2026-05-01", "addressLine": "Some street", "amenityIds": [] }`
- Scripts → Post-response:

```javascript
pm.test("Status 400", () => pm.response.to.have.status(400));
```

**[6.E3] Invalid status transition (active → filled directly by poster)**

- PATCH `{{baseUrl}}/listings/{{listing1Id}}/status`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body: `{ "status": "filled" }`

> Note: "filled" is a valid status but normally triggered by accepting an interest request that exhausts capacity. The
> service should allow this as a manual override. Test that it returns 200 and then check that all pending interests are
> expired. This tests the explicit fill path.

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
// Reactivate after this test since the listing is needed for interest flow
```

**[6.E4] Reactivate after fill test**

- Note: A "filled" listing cannot be reactivated. Create a new listing or use listing 2 for the interest flow.
  Alternatively skip 6.E3 until after the interest tests.

---

### 07 - Interest Requests → Happy Path

> Use Listing 1 and Listing 2 for interest tests. Make sure they are active.

**[7.1] Student 1 Expresses Interest in Listing 1 (PG Owner 1's listing)**

- POST `{{baseUrl}}/listings/{{listing1Id}}/interests`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"message": "Hi, I am Arjun, final year at IIT Bombay. Non-smoker, vegetarian. Very interested in the room. Can we arrange a visit?"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("interestRequest1Id", body.data.interestRequestId);
pm.test("Status is pending", () => pm.expect(body.data.status).to.eql("pending"));
```

**[7.2] Student 2 Expresses Interest in Listing 2 (PG Owner 2's listing)**

- POST `{{baseUrl}}/listings/{{listing2Id}}/interests`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Body:

```json
{
	"message": "Hi, I am Priya, second year at BITS. Vegetarian, early bird. Very interested in the ladies hostel bed."
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("interestRequest2Id", body.data.interestRequestId);
```

**[7.3] PG Owner 1 Views Interests on Listing 1**

- GET `{{baseUrl}}/listings/{{listing1Id}}/interests`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("At least 1 request", () => pm.expect(pm.response.json().data.items.length).to.be.above(0));
```

**[7.4] Student 1 Views Their Own Interests**

- GET `{{baseUrl}}/interests/me`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
```

**[7.5] Get Single Interest Request — Student 1**

- GET `{{baseUrl}}/interests/{{interestRequest1Id}}`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Status is pending", () => pm.expect(pm.response.json().data.status).to.eql("pending"));
```

**[7.6] PG Owner 1 Accepts Interest Request 1**

- PATCH `{{baseUrl}}/interests/{{interestRequest1Id}}/status`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body: `{ "status": "accepted" }`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test("Status is accepted", () => pm.expect(body.data.status).to.eql("accepted"));
pm.test("connectionId returned", () => pm.expect(body.data.connectionId).to.be.a("string"));
pm.environment.set("connection1Id", body.data.connectionId);
```

**[7.7] PG Owner 2 Accepts Interest Request 2**

- PATCH `{{baseUrl}}/interests/{{interestRequest2Id}}/status`
- Headers: `Authorization: Bearer {{pgOwner2AccessToken}}`
- Body: `{ "status": "accepted" }`
- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("connection2Id", body.data.connectionId);
```

**[7.8] Student 1 Sends Another Interest and then Withdraws It**

First, Student 1 sends interest in Listing 3 (Student 2's listing):

- POST `{{baseUrl}}/listings/{{listing3Id}}/interests`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "message": "Hey, am interested in the roommate spot." }`
- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("tempInterestId", body.data.interestRequestId);
```

Then withdraw it:

- PATCH `{{baseUrl}}/interests/{{tempInterestId}}/status`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "status": "withdrawn" }`
- Scripts → Post-response:

```javascript
pm.test("Status is withdrawn", () => {
	pm.expect(pm.response.json().data.status).to.eql("withdrawn");
});
```

---

### 07 - Interest Requests → Error Cases

**[7.E1] Student tries to send interest in their own listing**

- POST `{{baseUrl}}/listings/{{listing3Id}}/interests`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "message": "Self interest" }`
- Scripts → Post-response:

```javascript
pm.test("Status 422", () => pm.response.to.have.status(422));
```

**[7.E2] Send duplicate interest on same listing**

- POST `{{baseUrl}}/listings/{{listing1Id}}/interests`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "message": "Duplicate" }`
- Scripts → Post-response:

```javascript
pm.test("Status 409 conflict", () => pm.response.to.have.status(409));
```

**[7.E3] Student tries to accept an interest request (only poster can)**

- PATCH `{{baseUrl}}/interests/{{interestRequest2Id}}/status`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "status": "accepted" }`
- Scripts → Post-response:

```javascript
pm.test("Status 403 or 404", () => {
	pm.expect([403, 404]).to.include(pm.response.code);
});
```

**[7.E4] PG Owner tries to send an interest request**

- POST `{{baseUrl}}/listings/{{listing2Id}}/interests`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body: `{ "message": "Owner interest" }`
- Scripts → Post-response:

```javascript
pm.test("Status 403", () => pm.response.to.have.status(403));
```

---

### 08 - Connections → Happy Path

**[8.1] Student 1 Gets Connection 1 Detail**

- GET `{{baseUrl}}/connections/{{connection1Id}}`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("confirmationStatus is pending", () => {
	pm.expect(pm.response.json().data.confirmationStatus).to.eql("pending");
});
pm.test("initiatorConfirmed is false", () => {
	pm.expect(pm.response.json().data.initiatorConfirmed).to.be.false;
});
```

**[8.2] Student 1 Confirms Connection 1**

- POST `{{baseUrl}}/connections/{{connection1Id}}/confirm`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test("initiatorConfirmed is now true", () => pm.expect(body.data.initiatorConfirmed).to.be.true);
pm.test("Still pending (only one party confirmed)", () => {
	pm.expect(body.data.confirmationStatus).to.eql("pending");
});
```

**[8.3] PG Owner 1 Confirms Connection 1**

- POST `{{baseUrl}}/connections/{{connection1Id}}/confirm`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test("counterpartConfirmed is now true", () => pm.expect(body.data.counterpartConfirmed).to.be.true);
pm.test("confirmationStatus is now confirmed", () => {
	pm.expect(body.data.confirmationStatus).to.eql("confirmed");
});
```

**[8.4] Student 2 Confirms Connection 2**

- POST `{{baseUrl}}/connections/{{connection2Id}}/confirm`
- Headers: `Authorization: Bearer {{student2AccessToken}}`

**[8.5] PG Owner 2 Confirms Connection 2**

- POST `{{baseUrl}}/connections/{{connection2Id}}/confirm`
- Headers: `Authorization: Bearer {{pgOwner2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("confirmationStatus is confirmed", () => {
	pm.expect(pm.response.json().data.confirmationStatus).to.eql("confirmed");
});
```

**[8.6] Student 1 Views All Their Connections**

- GET `{{baseUrl}}/connections/me`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("At least 1 connection", () => pm.expect(pm.response.json().data.items.length).to.be.above(0));
```

**[8.7] Filter Connections by confirmationStatus**

- GET `{{baseUrl}}/connections/me?confirmationStatus=confirmed`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("All returned connections are confirmed", () => {
	pm.response.json().data.items.forEach((item) => {
		pm.expect(item.confirmationStatus).to.eql("confirmed");
	});
});
```

---

### 08 - Connections → Error Cases

**[8.E1] Third party tries to view a connection they are not party to**

- GET `{{baseUrl}}/connections/{{connection1Id}}`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 404", () => pm.response.to.have.status(404));
```

**[8.E2] Confirm a connection you are not party to**

- POST `{{baseUrl}}/connections/{{connection1Id}}/confirm`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 404", () => pm.response.to.have.status(404));
```

---

### 09 - Ratings → Happy Path

> Both connections must be confirmed before ratings can be submitted.

**[9.1] Student 1 Rates PG Owner 1 (user rating)**

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"connectionId": "{{connection1Id}}",
	"revieweeType": "user",
	"revieweeId": "{{pgOwner1Id}}",
	"overallScore": 4,
	"cleanlinessScore": 5,
	"communicationScore": 4,
	"reliabilityScore": 4,
	"comment": "Ravi was very responsive and the room was exactly as described. Great experience overall."
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("rating1Id", body.data.ratingId);
```

**[9.2] Student 1 Rates Property 1**

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"connectionId": "{{connection1Id}}",
	"revieweeType": "property",
	"revieweeId": "{{property1Id}}",
	"overallScore": 4,
	"cleanlinessScore": 5,
	"valueScore": 3,
	"comment": "Property is clean and well-maintained. Slightly overpriced for the locality."
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
```

**[9.3] PG Owner 1 Rates Student 1**

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"connectionId": "{{connection1Id}}",
	"revieweeType": "user",
	"revieweeId": "{{student1Id}}",
	"overallScore": 5,
	"cleanlinessScore": 5,
	"reliabilityScore": 5,
	"comment": "Arjun was an excellent tenant. Paid on time and kept the room clean."
}
```

**[9.4] Student 2 Rates PG Owner 2**

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Body:

```json
{
	"connectionId": "{{connection2Id}}",
	"revieweeType": "user",
	"revieweeId": "{{pgOwner2Id}}",
	"overallScore": 3,
	"communicationScore": 2,
	"cleanlinessScore": 4,
	"comment": "Room was clean but the owner was hard to reach when there were issues."
}
```

**[9.5] Get Ratings for Connection 1 (both parties' view)**

- GET `{{baseUrl}}/ratings/connection/{{connection1Id}}`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
const body = pm.response.json().data;
pm.test("myRatings is array", () => pm.expect(body.myRatings).to.be.an("array"));
pm.test("theirRatings is array", () => pm.expect(body.theirRatings).to.be.an("array"));
```

**[9.6] Get Public Ratings for PG Owner 1 (no auth needed)**

- GET `{{baseUrl}}/ratings/user/{{pgOwner1Id}}`
- No Authorization header.
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("At least 1 rating", () => pm.expect(pm.response.json().data.items.length).to.be.above(0));
```

**[9.7] Get Public Ratings for Property 1 (no auth needed)**

- GET `{{baseUrl}}/ratings/property/{{property1Id}}`
- No Authorization header.
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
```

**[9.8] Student 1 Views All Ratings They Have Given**

- GET `{{baseUrl}}/ratings/me/given`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Has at least 2 given ratings", () => {
	pm.expect(pm.response.json().data.items.length).to.be.at.least(2);
});
```

---

### 09 - Ratings → Error Cases

**[9.E1] Submit duplicate rating for same connection + reviewee**

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: same as 9.1 (same connectionId + revieweeId)
- Scripts → Post-response:

```javascript
pm.test("Status 409", () => pm.response.to.have.status(409));
```

**[9.E2] Rate someone who is not party to the connection**

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"connectionId": "{{connection1Id}}",
	"revieweeType": "user",
	"revieweeId": "{{student2Id}}",
	"overallScore": 5,
	"comment": "Rating a non-party should fail"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 422", () => pm.response.to.have.status(422));
```

**[9.E3] Rate on an unconfirmed connection**

> Create a new interest request between Student 1 and Listing 2, accept it, but do NOT confirm the connection. Then try
> to rate.

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:
  `{ "connectionId": "{{connection2Id}}", "revieweeType": "user", "revieweeId": "{{pgOwner2Id}}", "overallScore": 5, "comment": "Should fail if unconfirmed" }`

> Note: connection2 IS confirmed in 8.5. For a true negative test, you need a fresh unconfirmed connection. Skip this or
> create a new interest on listing 3 → accept but don't confirm.

**[9.E4] Self-rating attempt**

- POST `{{baseUrl}}/ratings`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"connectionId": "{{connection1Id}}",
	"revieweeType": "user",
	"revieweeId": "{{student1Id}}",
	"overallScore": 5,
	"comment": "Rating myself"
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 422", () => pm.response.to.have.status(422));
```

---

### 10 - Reports (Admin) → Happy Path

**[10.1] PG Owner 1 Reports Student 2's Rating of PG Owner 2**

> PG Owner 1 is party to connection1. Student 2 rated PG Owner 2 via connection2. PG Owner 1 is NOT party to
> connection2. This should return 404 (testing the party-membership check). Use PG Owner 2 to file the report instead.

**[10.1] PG Owner 2 Reports Student 2's Rating**

- POST `{{baseUrl}}/ratings/{{rating1Id}}/report`

> Wait — rating1Id is PG Owner 1 rated by Student 1. PG Owner 2 is not party to that connection. Use the correct party.
> PG Owner 1 should report a rating that was submitted ON connection1.

Correct flow: PG Owner 1 reports Student 2's rating if Student 2 submitted a rating on connection1. Since only Student 1
and PG Owner 1 are parties to connection1, only they can report ratings on it.

Let's say PG Owner 1 believes rating1 (Student 1's rating of PG Owner 1) is fake:

- POST `{{baseUrl}}/ratings/{{rating1Id}}/report`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"reason": "fake",
	"explanation": "This rating appears to be from someone I never actually hosted. Requesting review."
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
const body = pm.response.json();
pm.environment.set("report1Id", body.data.reportId);
pm.test("Status is open", () => pm.expect(body.data.status).to.eql("open"));
```

**[10.2] Admin Views Report Queue**

- GET `{{baseUrl}}/admin/report-queue`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("At least 1 report", () => pm.expect(pm.response.json().data.items.length).to.be.above(0));
```

**[10.3] Admin Resolves Report — Kept (rating is legitimate)**

- PATCH `{{baseUrl}}/admin/reports/{{report1Id}}/resolve`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"resolution": "resolved_kept",
	"adminNotes": "Reviewed the connection history. Rating appears genuine."
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("resolution is resolved_kept", () => {
	pm.expect(pm.response.json().data.resolution).to.eql("resolved_kept");
});
```

**[10.4] File a New Report and Resolve as Removed**

File a fresh report (PG Owner 1 reports again — the previous report was resolved so they can report again):

- POST `{{baseUrl}}/ratings/{{rating1Id}}/report`
- Headers: `Authorization: Bearer {{pgOwner1AccessToken}}`
- Body:

```json
{
	"reason": "abusive",
	"explanation": "The review text is personally attacking and abusive. Please remove."
}
```

- Scripts → Post-response:

```javascript
const body = pm.response.json();
pm.environment.set("report2Id", body.data.reportId);
```

Then resolve as removed:

- PATCH `{{baseUrl}}/admin/reports/{{report2Id}}/resolve`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body:

```json
{
	"resolution": "resolved_removed",
	"adminNotes": "Review contains personal attack language. Rating hidden per moderation policy."
}
```

- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("resolution is resolved_removed", () => {
	pm.expect(pm.response.json().data.resolution).to.eql("resolved_removed");
});
```

Then verify the rating is now invisible in the public feed:

- GET `{{baseUrl}}/ratings/user/{{pgOwner1Id}}`
- No Authorization header.
- Scripts → Post-response:

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
// The removed rating should not appear
const ids = pm.response.json().data.items.map((r) => r.ratingId);
pm.test("Removed rating not in public feed", () => {
	pm.expect(ids).to.not.include(pm.environment.get("rating1Id"));
});
```

---

### 10 - Reports → Error Cases

**[10.E1] Non-party files a report**

- POST `{{baseUrl}}/ratings/{{rating1Id}}/report`
- Headers: `Authorization: Bearer {{student2AccessToken}}`
- Body: `{ "reason": "fake", "explanation": "I was not part of this connection" }`
- Scripts → Post-response:

```javascript
pm.test("Status 404", () => pm.response.to.have.status(404));
```

**[10.E2] Resolve a report without adminNotes when resolution is resolved_removed**

- PATCH `{{baseUrl}}/admin/reports/{{report1Id}}/resolve`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "resolution": "resolved_removed" }`
- Scripts → Post-response:

```javascript
pm.test("Status 400", () => pm.response.to.have.status(400));
```

**[10.E3] Resolve an already-resolved report**

- PATCH `{{baseUrl}}/admin/reports/{{report1Id}}/resolve`
- Headers: `Authorization: Bearer {{student1AccessToken}}`
- Body: `{ "resolution": "resolved_kept", "adminNotes": "Trying to resolve twice" }`
- Scripts → Post-response:

```javascript
pm.test("Status 409", () => pm.response.to.have.status(409));
```

---

## Part 5 — Quick Navigation Tips in Postman (New UI, Linux)

**Running all requests in order:**

1. Right-click the collection → **Run collection**.
2. The Collection Runner opens. All requests are listed in order.
3. Click **Run Roomies API** to execute them sequentially with all scripts active.
4. Results show pass/fail per test assertion inline.

**Viewing the raw request/response:**

- Click the **Console** button in the bottom footer bar (`Ctrl+Alt+C`).
- Every request shows the exact URL, headers, and response body sent/received.

**Re-running a single request after a failure:**

- Click the request in the sidebar → it opens in a tab → hit **Send** (`Ctrl+Enter`).

**Checking current variable values:**

- Click the **eye icon** in the top-right next to the environment name to see all current variable values at a glance.

**Adding a variable manually (e.g. pasting an OTP):**

- Click the environment name → find the variable → edit the value directly.

**Postman Console for debugging scripts:**

- In any post-response script, use `console.log(pm.response.json())` to print to the Console tab.

---

## Part 6 — Test Execution Order Summary

Follow this order to ensure every variable is populated before it is used:

```
00 Health
01.1 → 01.5   Register all 5 users
01.6           Login Student 1 (refresh token)
01.10 → 01.11 OTP flow for Student 1 (check Ethereal terminal log)
02.3 → 02.4   Update student profiles
03.2 → 03.4   Update PG owner profiles
[DB SQL]       Grant admin role to Student 1
01.6           Re-login Student 1 (get fresh token with admin role)
04.1 → 04.3   All 3 PG owners submit documents
04.4           Admin views queue
04.5 → 04.6   Approve PG Owner 1 and 2
04.7           Reject PG Owner 3
04.8 → 04.9   PG Owner 3 resubmits and is approved
05.1 → 05.2   Create properties
06.1 → 06.4   Create all 4 listings
07.1 → 07.2   Students send interest requests
07.6 → 07.7   Owners accept the requests (connectionIds captured)
08.2 → 08.5   Both parties confirm both connections
09.1 → 09.4   Submit ratings
10.1           File a report
10.2 → 10.3   Admin resolves report
```

## That is the complete plan — every request, every script, every error case, in exact folder and execution order.

Let's get Postman set up properly before touching a single request.

---

## Step 1 — Open Postman and orient yourself

When Postman opens you will see:

- **Left sidebar** — Collections, Environments, History icons on the far left edge
- **Top bar** — workspace name, environment dropdown (top-right), your avatar
- **Center** — the workbench / tab area
- **Bottom footer bar** — Console, Runner, Cookies buttons

---

## Step 2 — Create a Workspace (keep things clean)

1. Click the **Workspaces** dropdown in the top-left header
2. Click **Create Workspace**
3. Choose **Blank workspace**
4. Name it: `Roomies Backend Testing`
5. Set visibility to **Personal**
6. Click **Create**

---

## Step 3 — Create the Environment

1. Click the **Environments** icon in the left sidebar (looks like a slider/toggle icon)
2. Click **+** to create a new environment
3. Name it exactly: `Roomies Local`
4. Now add the variables one by one using the table below

For each variable:

- Type the name in the **Variable** column
- Set the value where shown
- Tick **Sensitive** checkbox for anything marked yes
- Leave the value blank for variables that will be auto-filled by scripts

| Variable                 | Value to enter now             | Sensitive |
| ------------------------ | ------------------------------ | --------- |
| `baseUrl`                | `http://localhost:3000/api/v1` | No        |
| `student1AccessToken`    | _(blank)_                      | Yes       |
| `student1RefreshToken`   | _(blank)_                      | Yes       |
| `student1Id`             | _(blank)_                      | No        |
| `student2AccessToken`    | _(blank)_                      | Yes       |
| `student2RefreshToken`   | _(blank)_                      | Yes       |
| `student2Id`             | _(blank)_                      | No        |
| `pgOwner1AccessToken`    | _(blank)_                      | Yes       |
| `pgOwner1RefreshToken`   | _(blank)_                      | Yes       |
| `pgOwner1Id`             | _(blank)_                      | No        |
| `pgOwner2AccessToken`    | _(blank)_                      | Yes       |
| `pgOwner2RefreshToken`   | _(blank)_                      | Yes       |
| `pgOwner2Id`             | _(blank)_                      | No        |
| `pgOwner3AccessToken`    | _(blank)_                      | Yes       |
| `pgOwner3RefreshToken`   | _(blank)_                      | Yes       |
| `pgOwner3Id`             | _(blank)_                      | No        |
| `property1Id`            | _(blank)_                      | No        |
| `property2Id`            | _(blank)_                      | No        |
| `listing1Id`             | _(blank)_                      | No        |
| `listing2Id`             | _(blank)_                      | No        |
| `listing3Id`             | _(blank)_                      | No        |
| `listing4Id`             | _(blank)_                      | No        |
| `interestRequest1Id`     | _(blank)_                      | No        |
| `interestRequest2Id`     | _(blank)_                      | No        |
| `tempInterestId`         | _(blank)_                      | No        |
| `connection1Id`          | _(blank)_                      | No        |
| `connection2Id`          | _(blank)_                      | No        |
| `rating1Id`              | _(blank)_                      | No        |
| `report1Id`              | _(blank)_                      | No        |
| `report2Id`              | _(blank)_                      | No        |
| `verificationRequest1Id` | _(blank)_                      | No        |
| `verificationRequest2Id` | _(blank)_                      | No        |
| `verificationRequest3Id` | _(blank)_                      | No        |

5. Click **Save** (or it autosaves — you will see a green dot disappear)
6. **Activate the environment** — in the top-right corner of Postman click the environment dropdown that says **No
   environment** and select **Roomies Local**

You should now see `Roomies Local` shown in the top-right. The eye icon next to it lets you peek at all variable values
at any time.

---

## Step 4 — Create the Collection

1. Click **Collections** icon in the left sidebar
2. Click **+** → **Blank collection**
3. Name it: `Roomies API — Full E2E Test Suite`
4. Click the collection name to open its settings panel on the right

---

## Step 5 — Set the Collection-level Header

This is the most important step. Adding `X-Client-Transport: bearer` at the collection level means every single request
automatically sends it, so tokens come back in the JSON body and your scripts can capture them.

1. With the collection selected, click the **Headers** tab in the right panel
2. Click **Add header**
3. Key: `X-Client-Transport`
4. Value: `bearer`

---

## Step 6 — Set the Collection-level Pre-request Script

1. Still on the collection settings, click the **Scripts** tab
2. In the **Pre-request** section paste:

```javascript
// Safety net: ensure baseUrl is always set
if (!pm.environment.get("baseUrl")) {
	pm.environment.set("baseUrl", "http://localhost:3000/api/v1");
	console.log("baseUrl was missing — set to default");
}
```

---

## Step 7 — Create all the Folders

Right-click the collection name → **Add folder** for each one. Create them in this exact order:

```
00 - Health Check
01 - Auth
02 - Student Profiles
03 - PG Owner Profiles
04 - Verification (Admin)
05 - Properties
06 - Listings
07 - Interest Requests
08 - Connections
09 - Ratings
10 - Reports (Admin)
```

Then for each numbered folder, right-click it → **Add folder** to create two subfolders inside:

```
Happy Path
Error Cases
```

When done your sidebar tree looks like this:

```
📁 Roomies API — Full E2E Test Suite
  📁 00 - Health Check
  📁 01 - Auth
    📁 Happy Path
    📁 Error Cases
  📁 02 - Student Profiles
    📁 Happy Path
    📁 Error Cases
  ... and so on
```

---

## Step 8 — Verify the setup before adding any requests

Do this quick sanity check:

1. Click the **eye icon** next to `Roomies Local` in the top-right
2. Confirm `baseUrl` shows `http://localhost:3000/api/v1`
3. Open the **Console** (bottom footer → Console or `Ctrl+Alt+C`)
4. Keep it open while testing — every request/response will appear there

---

## Step 9 — Quick smoke test to confirm Postman can reach your server

1. Click the `00 - Health Check` folder
2. Right-click → **Add request**
3. Name it `GET Health`
4. Set method to **GET**
5. URL: `{{baseUrl}}/health`
6. Click **Send**

You should see in the response: `Working `

```json
{
	"status": "ok",
	"timestamp": "...",
	"services": {
		"database": "ok",
		"redis": "ok"
	}
}
```

## Now the postman base setup is done, health route is working.

Perfect. All three services are up and responding. Let's start building the requests folder by folder.

---

## Folder 01 - Auth → Happy Path

We are adding 11 requests. For each one:

- Right-click the **Happy Path** subfolder inside **01 - Auth** → **Add request**
- Set the name, method, URL, body, and script exactly as shown

---

### [1.1] Register Student 1

- **Name:** `[1.1] Register Student 1`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/register`
- **Body tab** → select **raw** → dropdown set to **JSON**:

```json
{
	"email": "arjun.sharma@student.iitb.ac.in",
	"password": "Test1234",
	"role": "student",
	"fullName": "Arjun Sharma"
}
```

- **Scripts tab** → **Post-response** section:

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));
pm.test("Returns access token", () => {
	const body = pm.response.json();
	pm.expect(body.data.accessToken).to.be.a("string");
});

const body = pm.response.json();
pm.environment.set("student1AccessToken", body.data.accessToken);
pm.environment.set("student1RefreshToken", body.data.refreshToken);
pm.environment.set("student1Id", body.data.user.userId);

console.log("student1Id:", body.data.user.userId);
```

Click **Send**. Expected: `201 Created`.

---

### [1.2] Register Student 2

- **Name:** `[1.2] Register Student 2`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/register`
- **Body:**

```json
{
	"email": "priya.nair@student.bits.ac.in",
	"password": "Test1234",
	"role": "student",
	"fullName": "Priya Nair"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));

const body = pm.response.json();
pm.environment.set("student2AccessToken", body.data.accessToken);
pm.environment.set("student2RefreshToken", body.data.refreshToken);
pm.environment.set("student2Id", body.data.user.userId);

console.log("student2Id:", body.data.user.userId);
```

---

### [1.3] Register PG Owner 1

- **Name:** `[1.3] Register PG Owner 1`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/register`
- **Body:**

```json
{
	"email": "ravi.mehta@gmail.com",
	"password": "Test1234",
	"role": "pg_owner",
	"fullName": "Ravi Mehta",
	"businessName": "Mehta PG House"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));

const body = pm.response.json();
pm.environment.set("pgOwner1AccessToken", body.data.accessToken);
pm.environment.set("pgOwner1RefreshToken", body.data.refreshToken);
pm.environment.set("pgOwner1Id", body.data.user.userId);

console.log("pgOwner1Id:", body.data.user.userId);
```

---

### [1.4] Register PG Owner 2

- **Name:** `[1.4] Register PG Owner 2`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/register`
- **Body:**

```json
{
	"email": "sunita.kapoor@gmail.com",
	"password": "Test1234",
	"role": "pg_owner",
	"fullName": "Sunita Kapoor",
	"businessName": "Kapoor Ladies Hostel"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));

const body = pm.response.json();
pm.environment.set("pgOwner2AccessToken", body.data.accessToken);
pm.environment.set("pgOwner2RefreshToken", body.data.refreshToken);
pm.environment.set("pgOwner2Id", body.data.user.userId);

console.log("pgOwner2Id:", body.data.user.userId);
```

---

### [1.5] Register PG Owner 3

- **Name:** `[1.5] Register PG Owner 3`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/register`
- **Body:**

```json
{
	"email": "deepak.joshi@gmail.com",
	"password": "Test1234",
	"role": "pg_owner",
	"fullName": "Deepak Joshi",
	"businessName": "Joshi Paying Guest"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 201", () => pm.response.to.have.status(201));

const body = pm.response.json();
pm.environment.set("pgOwner3AccessToken", body.data.accessToken);
pm.environment.set("pgOwner3RefreshToken", body.data.refreshToken);
pm.environment.set("pgOwner3Id", body.data.user.userId);

console.log("pgOwner3Id:", body.data.user.userId);
```

---

### [1.6] Login Student 1

- **Name:** `[1.6] Login Student 1`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/login`
- **Body:**

```json
{
	"email": "arjun.sharma@student.iitb.ac.in",
	"password": "Test1234"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));

const body = pm.response.json();
pm.environment.set("student1AccessToken", body.data.accessToken);
pm.environment.set("student1RefreshToken", body.data.refreshToken);

console.log("Student 1 token refreshed via login");
```

---

### [1.7] Get Me — Student 1

- **Name:** `[1.7] Get Me — Student 1`
- **Method:** GET
- **URL:** `{{baseUrl}}/auth/me`
- **Headers tab** → Add:
    - Key: `Authorization`
    - Value: `Bearer {{student1AccessToken}}`

- **Scripts → Post-response:**

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Has userId", () => {
	pm.expect(pm.response.json().data.userId).to.be.a("string");
});
pm.test("Has student role", () => {
	pm.expect(pm.response.json().data.roles).to.include("student");
});
```

---

### [1.8] Refresh Token — Student 1

- **Name:** `[1.8] Refresh Token — Student 1`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/refresh`
- **Body:**

```json
{
	"refreshToken": "{{student1RefreshToken}}"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));

const body = pm.response.json();
pm.environment.set("student1AccessToken", body.data.accessToken);
pm.environment.set("student1RefreshToken", body.data.refreshToken);

console.log("Student 1 tokens rotated via refresh");
```

---

### [1.9] List Sessions — Student 1

- **Name:** `[1.9] List Sessions — Student 1`
- **Method:** GET
- **URL:** `{{baseUrl}}/auth/sessions`
- **Headers:** `Authorization: Bearer {{student1AccessToken}}`

- **Scripts → Post-response:**

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Returns array of sessions", () => {
	pm.expect(pm.response.json().data).to.be.an("array");
});
pm.test("At least 1 session exists", () => {
	pm.expect(pm.response.json().data.length).to.be.above(0);
});
```

---

### [1.10] Send OTP — Student 1

> Student 1 used a non-institution email so they need manual OTP verification. After hitting Send, watch your **server
> terminal** — you will see a line like: `previewUrl: "https://ethereal.email/message/ABC123..."` Open that URL in a
> browser to get the 6-digit OTP code.

- **Name:** `[1.10] Send OTP — Student 1`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/otp/send`
- **Headers:** `Authorization: Bearer {{student1AccessToken}}`
- **Body:** none (no body needed)

- **Scripts → Post-response:**

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("OTP sent message", () => {
	pm.expect(pm.response.json().message).to.include("OTP");
});
console.log("CHECK YOUR SERVER TERMINAL for the Ethereal Mail preview URL");
```

---

### [1.11] Verify OTP — Student 1

> Before sending this request, go to your server terminal, copy the Ethereal preview URL, open it in a browser, and copy
> the 6-digit OTP from the email. Then paste it into the body below.

- **Name:** `[1.11] Verify OTP — Student 1`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/otp/verify`
- **Headers:** `Authorization: Bearer {{student1AccessToken}}`
- **Body:**

```json
{
	"otp": "PASTE_6_DIGIT_CODE_HERE"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 200", () => pm.response.to.have.status(200));
pm.test("Email verified message", () => {
	pm.expect(pm.response.json().message).to.include("verified");
});
console.log("Student 1 email is now verified");
```

---

Now add the Error Cases. Right-click the **Error Cases** subfolder inside **01 - Auth** → **Add request** for each:

---

### [1.E1] Duplicate Email Registration

- **Name:** `[1.E1] Duplicate Email Registration`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/register`
- **Body:**

```json
{
	"email": "arjun.sharma@student.iitb.ac.in",
	"password": "Test1234",
	"role": "student",
	"fullName": "Fake Arjun"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 409 — duplicate email rejected", () => {
	pm.response.to.have.status(409);
});
```

---

### [1.E2] Wrong Password Login

- **Name:** `[1.E2] Wrong Password Login`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/login`
- **Body:**

```json
{
	"email": "arjun.sharma@student.iitb.ac.in",
	"password": "WrongPassword99"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 401 — invalid credentials", () => {
	pm.response.to.have.status(401);
});
```

---

### [1.E3] PG Owner Register Without businessName

- **Name:** `[1.E3] PG Owner Without businessName`
- **Method:** POST
- **URL:** `{{baseUrl}}/auth/register`
- **Body:**

```json
{
	"email": "nobusiness@test.com",
	"password": "Test1234",
	"role": "pg_owner",
	"fullName": "No Business"
}
```

- **Scripts → Post-response:**

```javascript
pm.test("Status 400 — businessName required", () => {
	pm.response.to.have.status(400);
});
```

---

### [1.E4] Access Protected Route Without Token

- **Name:** `[1.E4] No Token — Protected Route`
- **Method:** GET
- **URL:** `{{baseUrl}}/auth/me`
- **Headers:** make sure there is NO Authorization header (remove it if Postman auto-added one)

- **Scripts → Post-response:**

```javascript
pm.test("Status 401 — no token", () => {
	pm.response.to.have.status(401);
});
```

---

### [1.E5] Invalid Token

- **Name:** `[1.E5] Invalid Token`
- **Method:** GET
- **URL:** `{{baseUrl}}/auth/me`
- **Headers:**
    - `Authorization: Bearer thisisacompletlyfaketokenstring`

- **Scripts → Post-response:**

```javascript
pm.test("Status 401 — invalid token", () => {
	pm.response.to.have.status(401);
});
```

---

## Before you send anything — run them in order

Send requests **1.1 through 1.5 first** (the five registrations), then check your environment variables:

1. Click the **eye icon** next to `Roomies Local` in the top-right
2. You should see all five IDs and tokens now populated with real values

If any of those are still blank after sending, it means either the request got a non-201 response or the script did not
run. Check the **Console** at the bottom — it will show the exact error.

---

Go ahead and run 1.1 through 1.11 now and tell me what you see — pass/fail counts per request, and any errors in the
Console. Once auth is clean we move straight into folder 02.

Answer -> Everything worked as expected.

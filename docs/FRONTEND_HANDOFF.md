# TrustCare — Frontend Handoff

เอกสารสำหรับทีมที่จะสร้างหน้าบ้านจริง

ระหว่างพัฒนาหลังบ้าน เราสร้างเว็บทดสอบขึ้นมาเพื่อพิสูจน์ว่า flow ทั้งหมดทำงานได้จริง
**เว็บทดสอบนั้นถูกลบออกไปแล้ว** เพราะไม่ใช่ของที่จะส่งมอบ — เอกสารนี้บันทึกไว้ว่ามีหน้าอะไรบ้าง
แต่ละหน้าเรียก API อะไร และมีกฎอะไรที่หน้าบ้านต้องเคารพ

ระบบที่ส่งมอบคือ **backend อย่างเดียว**: Node/Express API + Python AI service + Supabase

---

## 1. เริ่มต้นใช้งาน

```bash
cd backend && npm install
node src/server.js                 # http://localhost:3000

cd ai-service && pip install -r requirements.txt
python -m uvicorn app.main:app --port 8001
```

ตรวจว่าพร้อม: `GET http://localhost:3000/api/health`

```json
{
  "ok": true, "status": "up",
  "env": { "OPENAI_API_KEY": "set", "SUPABASE_URL": "set", "score_version": "matching-v4" },
  "store": { "driver": "supabase", "counts": { "caregiver_profiles": 20 } },
  "ai_service": { "reachable": true }
}
```

`STORE=memory` (ค่าเริ่มต้น) เก็บข้อมูลในหน่วยความจำ เหมาะกับการพัฒนา · `STORE=supabase` ใช้ฐานข้อมูลจริง

### ข้อมูลทดสอบ

`POST /api/dev/seed` สร้าง 5 ครอบครัว · 5 ผู้สูงอายุ · 20 ผู้ดูแล · 15 คำขอ
`POST /api/dev/reset` ล้างแล้วสร้างใหม่

ผู้ดูแลที่ใช้ทดสอบบ่อย:

| code | ใช้ทดสอบอะไร |
|---|---|
| `CG_NEAR_01` | เคสสมบูรณ์ ห่าง 3 กม. ทักษะครบ trust 92 |
| `CG_FAR_PERFECT_01` | เหมาะมากแต่ห่าง 145 กม. — ทดสอบ exceptional match |
| `CG_FAR_NO_OPTIN` | เหมาะมาก ไกล แต่ไม่รับงานนอกพื้นที่ — ต้องไม่ถูกแสดง |
| `CG-12` | ทักษะครบแต่ยังไม่ยืนยันตัวตน — ต้องถูกกรองออก |
| `CG-08` | ทักษะพื้นฐานเท่านั้น — ใช้ทดสอบการถูกปฏิเสธ |

> **อย่าชี้ชุดเทสต์ไปที่ Supabase project ที่ใช้งานร่วมกัน** — `beforeEach` เรียก reset ซึ่งลบข้อมูลทั้งหมด

---

## 2. หน้าจอที่มีในเว็บทดสอบ

### ฝั่งครอบครัว

#### หน้า 1–5 — ตัวช่วยหาผู้ดูแล (wizard)

| ขั้น | หน้าจอ | เก็บอะไร |
|---|---|---|
| 1 | ข้อมูลผู้สูงอายุ | ชื่อ อายุ เพศ การเคลื่อนไหว โรค ภาษา + **ตัวอย่างสำเร็จรูป 6 เคส** กดแล้วกรอกให้อัตโนมัติ |
| 2 | สิ่งที่ต้องการให้ช่วย | งานที่ต้องทำ ทักษะบังคับ เงื่อนไขพิเศษ เพศผู้ดูแล |
| 3 | เวลา สถานที่ งบ | วันเวลา · **ปักหมุดแผนที่** · งบ · ลักษณะงาน · ประสบการณ์ขั้นต่ำ · **รัศมีที่ยอมรับได้** · รับคนนอกพื้นที่ |
| 4 | ตารางการดูแลรายวัน | **พูดหรือพิมพ์** แล้ว AI จัดเป็นตารางเวลา แก้ไขได้ทุกช่อง |
| 5 | ตรวจทานข้อมูล | สรุปทั้งหมด + ปุ่ม **"ยืนยัน เริ่มค้นหา"** และ **"ประกาศงานไว้ก่อน ไม่ค้นหาตอนนี้"** |

**ข้อควรระวังจาก UX ที่เราเจอเอง**

- วันที่เริ่มต้นควรเป็นวันที่มีผู้ดูแลว่างจริง เราเคยตั้งเป็น "พรุ่งนี้" ซึ่งตรงวันอาทิตย์ ทำให้แมตช์แทบไม่ได้
  และดูเหมือนระบบพัง ทั้งที่เป็นเรื่องตารางงาน → **ควรบอกผู้ใช้ว่าวันที่เลือกตรงกับวันอะไร**
- ถ้าตารางรายวันมีเวลาเลยช่วงกะที่ขอ ให้เตือน ไม่งั้นจะหาคนว่างครบไม่ได้และผู้ใช้ไม่รู้สาเหตุ

#### หน้า 6 — กำลังวิเคราะห์

หน้ารอพร้อมรายการติ๊กทีละข้อ (ตรวจการยืนยันตัวตน → คัดทักษะ/ภาษา → ตรวจความว่าง → คำนวณระยะทาง → ให้คะแนน → จัดอันดับ)
API ตอบเร็วมาก (~5 ms) หน้ารอมีไว้ให้ผู้ใช้เข้าใจว่าระบบทำอะไร ไม่ใช่เพราะช้า

#### หน้า 7 — ผลการจับคู่

- **กล่องเปรียบเทียบสองทางเลือกด้านบน** (ถ้ามีคนนอกพื้นที่) — ดูข้อ 4
- การ์ดผู้ดูแลเรียงตามความเหมาะสม: วงเปอร์เซ็นต์ · ป้าย "แนะนำที่สุด"/"ยืนยันตัวตนแล้ว" ·
  ประสบการณ์ ระยะทาง ค่าบริการ trust · **เหตุผล ✓** · **ข้อควรพิจารณา !** ·
  กางดูคะแนนแยก 11 ด้าน · ปุ่ม **"ดูรายละเอียดทั้งหมด"** · ปุ่มส่งคำขอ
- แถบสรุปว่าคัดใครออกเพราะอะไร เช่น `ไม่มีทักษะที่จำเป็น 11 คน` `ไม่ว่างในช่วงเวลานี้ 3 คน`

#### หน้า 8–9 — ส่งคำขอ / จับคู่สำเร็จ

รอผู้ดูแลตอบรับ → เมื่อรับแล้วแสดงสรุปพร้อม **เหตุผลที่ผู้ดูแลตอบรับ** (แต่ละข้ออ้างอิง feature ได้)

#### แท็บอื่นของครอบครัว

| แท็บ | ทำอะไร |
|---|---|
| **ประกาศงานของฉัน** | รายการประกาศ · แผนที่ · เปิด/ปิดประกาศ · **ลบประกาศ** · ดูคนที่สมัครมาพร้อมข้อความ · ปุ่ม **"+ ประกาศงานใหม่"** (ฟอร์มสั้นหน้าเดียว ไม่ต้องผ่าน wizard) |
| **ผู้ดูแลที่สนใจงานของฉัน** | คนที่กดสนใจ พร้อมคะแนนและเหตุผล · ป้ายบอกว่ามาจากประกาศหรือจากการค้นหา |
| **งานของฉัน** | งานที่กำลังดำเนินอยู่ |

### ฝั่งผู้ดูแล

| แท็บ | ทำอะไร |
|---|---|
| **ประกาศงานทั้งหมด** | **ลิสต์ธรรมดา ไม่มีคะแนน ไม่มีการจัดอันดับ** — "ตอนนี้มี N ครอบครัวกำลังหาผู้ดูแล" · มีตัวกรองแบบพับเก็บ · กดดูรายละเอียด → สมัคร |
| **ค้นหางานที่ต้องการ** | กรอกเงื่อนไขตัวเอง (ค่าบริการขั้นต่ำ รัศมี ชั่วโมงต่อกะ กะที่รับได้) → หน้าวิเคราะห์ → ผลลัพธ์ |
| **งานที่เหมาะกับฉัน** | ผลจากการค้นหา — **ต้องกรอกเงื่อนไขก่อน** ไม่ขึ้นเองโดยไม่ถาม |
| **คำขอรับงาน** | กล่องขาเข้า พร้อมแผนที่ ตารางรายวัน เหตุผล ยอมรับ/ปฏิเสธ |
| **งานของฉัน** | งานที่รับแล้ว |

### หน้างาน (ทั้งสองฝั่งเห็น)

- แผนที่ **หมุดจริง + วงกลม geofence** + จุดที่พักผู้ดูแล + เส้นเชื่อม
- สถานะการติดตาม (ปกติ/เฝ้าสังเกต/ต้องตรวจสอบ/ต้องให้ความสนใจ/เสี่ยงสูง)
- รายการงานตามตาราง — ผู้ดูแลติ๊กทีละรายการ
- ปุ่มเหตุการณ์ (ผู้ดูแลเท่านั้น): เช็คอิน · GPS · ออก/เข้าพื้นที่ · SOS · เช็คเอาท์
- ไทม์ไลน์ · การแจ้งเตือน · รายงานประจำวัน · รีวิว · แชท

### ที่ปรึกษา AI (ลอยทุกหน้า)

ปุ่มกลมมุมขวาล่าง → หน้าต่างแชท · มีคำถามแนะนำเปลี่ยนตามหน้าที่อยู่ ·
ตอบจากคะแนนที่คำนวณจริง ไม่ได้เดา

---

## 3. API ที่หน้าบ้านต้องใช้

Base URL: `http://localhost:3000/api`
ทุก response มี `ok: true|false` · error มี `error`, `message` และบางครั้ง `reasons[]`, `hint`

### กลุ่มที่ออกแบบมาเพื่อหน้าบ้านโดยเฉพาะ (`/api/app/*`)

API ใน `/api/*` เฉย ๆ เป็นแบบ one-endpoint-per-table เหมาะกับ debug
**หน้าบ้านควรใช้ `/api/app/*` เป็นหลัก** เพราะออกแบบตามสิ่งที่ผู้ใช้ทำจริง

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| GET | `/app/accounts` | รายชื่อบัญชีครอบครัวและผู้ดูแล (ใช้ตอนทดสอบ ของจริงใช้ auth) |
| **POST** | **`/app/find-caregivers`** | ฟอร์มทั้ง 5 ขั้น → สร้าง care request + แมตช์ + คืนผลพร้อมเหตุผล |
| POST | `/app/send-request` | ส่งคำขอ (สร้าง+ยืนยัน care plan ให้อัตโนมัติ) |
| GET | `/app/inbox/:caregiverId` | กล่องคำขอของผู้ดูแล |
| POST | `/app/respond` | ผู้ดูแลตอบรับ/ปฏิเสธ |
| GET | `/app/summary/:jobRequestId` | สรุปหลังจับคู่สำเร็จ |
| GET | `/app/caregiver/:id/jobs` | งานที่แนะนำให้ผู้ดูแล |
| POST | `/app/caregiver-interest` | ผู้ดูแลกดสนใจงาน |
| GET | `/app/family/:familyId/incoming` | ครอบครัวดูคนที่สนใจงานตัวเอง |
| POST | `/app/family-accept-interest` | ครอบครัวตอบรับ → mutual match |
| GET | `/app/my/:kind/:id` | งานของฉัน (`kind` = `family` \| `caregiver`) |

### งาน (หลังจับคู่แล้ว)

| Method | Path | |
|---|---|---|
| GET | `/app/job/:jobId` | ทุกอย่างของหน้างาน: แผนที่ ตาราง เหตุการณ์ สถานะ รายงาน รีวิว |
| POST | `/app/job/:jobId/event` | ส่งเหตุการณ์ `{event_type, payload, dedupe_key}` |
| POST | `/app/job/:jobId/report` | รายงานประจำวัน `{text}` → AI จัดโครงสร้าง |
| POST | `/app/job/:jobId/review` | รีวิว → คำนวณ trust ใหม่ |
| GET/POST | `/app/chat/:threadId` | แชท |

### ตารางการดูแล

| Method | Path | |
|---|---|---|
| POST | `/app/care-plan/draft` | `{text}` ภาษาพูดไทย → ตารางเวลา |
| POST | `/app/care-plan/transcribe` | ส่งไฟล์เสียง (raw body) → transcript |
| POST | `/app/care-plan/save` | `{care_request_id, items[]}` → ยืนยันแผน |
| GET | `/app/care-plan/:careRequestId` | อ่านแผน |

### กระดานประกาศ

| Method | Path | |
|---|---|---|
| GET | `/app/board/open` | ประกาศทั้งหมด **ไม่มีคะแนน** · filter: `date_from`, `date_to`, `min_budget`, `max_budget`, `task`, `skill`, `night`, `no_lifting`, `no_escort` |
| GET | `/app/board/mine/:familyId` | ประกาศของครอบครัว + ผู้สมัคร |
| GET | `/app/board/:careRequestId` | รายละเอียดประกาศ |
| POST | `/app/board/:careRequestId/visibility` | เปิด/ปิดประกาศ |
| DELETE | `/app/board/:careRequestId` | ลบ (ปฏิเสธถ้ามีคนรับงานแล้ว) |

### ตลาดสองทาง

| Method | Path | |
|---|---|---|
| POST | `/app/market/publish-job` | ประกาศงานโดยไม่แมตช์ |
| POST | `/app/market/offer` | ผู้ดูแลสมัครงาน (ตรวจเงื่อนไขบังคับตรงนี้) |
| POST | `/app/market/caregiver-search` | ผู้ดูแลค้นหางานตามเงื่อนไขตัวเอง |
| GET | `/app/market/caregiver/:id/detail` | โปรไฟล์เต็มสำหรับปุ่ม "ดูรายละเอียด" |

### ที่ปรึกษา AI

| Method | Path | |
|---|---|---|
| POST | `/app/advisor/message` | `{message, conversation_id, context}` |
| GET | `/app/advisor/suggestions?screen=` | คำถามแนะนำ (`results`/`caregiver`/`plan`/`form`/`job`) |

### การแจ้งเตือน (V5 §29)

> เว็บทดสอบเดิมไม่มีหน้านี้ — เป็นส่วนที่หน้าบ้านต้องออกแบบเอง
> รูปแบบที่ตรงกับ API นี้ที่สุดคือ **กระดิ่งบน header (นับเลขจาก `unread-count`) + หน้ารายการ**

`:who` = `FAMILY` \| `CAREGIVER` · `:id` = profile id ของครอบครัว หรือ caregiver profile id
ทั้งสองรับ code แบบอ่านง่าย (`FAM-1`, `CG-03`) ได้เหมือนที่อื่น

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| GET | `/app/notifications/:who/:id` | กล่องแจ้งเตือน ใหม่สุดขึ้นก่อน · `?unread=true` เอาเฉพาะที่ยังไม่อ่าน · `?limit=` (สูงสุด 200) |
| GET | `/app/notifications/:who/:id/unread-count` | เลขบนกระดิ่งอย่างเดียว สำหรับ header ที่ poll |
| POST | `/app/notifications/:id/read` | ทำเครื่องหมายว่าอ่านแล้ว 1 รายการ |
| POST | `/app/notifications/:who/:id/read-all` | อ่านทั้งกล่อง คืน `{marked_read}` |
| GET | `/app/notification-types` | รายการชนิดทั้ง 13 แยกตามฝั่ง — ใช้ map ไอคอนและหน้าปลายทาง |

**13 ชนิด** — ฝั่งครอบครัว 7 · ฝั่งผู้ดูแล 6

| ฝั่งครอบครัว | เกิดเมื่อ |
|---|---|
| `CAREGIVER_INTERESTED` | ผู้ดูแลกดสนใจงาน |
| `CAREGIVER_ACCEPTED` | ผู้ดูแลตอบรับคำขอ |
| `CAREGIVER_DECLINED` | ผู้ดูแลปฏิเสธ (มีเหตุผลถ้าเขากรอก) |
| `NEW_EXCEPTIONAL_CANDIDATE` | เจอคนเหมาะมากแต่อยู่นอกพื้นที่ |
| `CHAT_MESSAGE_FROM_CAREGIVER` | ข้อความใหม่จากผู้ดูแล |
| `CARE_PLAN_REQUIRED` | ส่งคำขอไม่ได้เพราะยังไม่ได้ยืนยันรายการงานดูแล |
| `DAILY_REPORT_READY` | รายงานประจำวันถูกยืนยันแล้ว |

| ฝั่งผู้ดูแล | เกิดเมื่อ |
|---|---|
| `NEW_MATCHING_JOB` | มีงานใหม่ที่ตรงกับโปรไฟล์ (จากการรันแมตช์ของครอบครัว) |
| `FAMILY_INTERESTED` | ครอบครัวกดสนใจโปรไฟล์ |
| `DIRECT_JOB_REQUEST` | ได้รับคำขอรับงานโดยตรง |
| `EXCEPTIONAL_DISTANCE_REQUEST` | คำขอ/ความสนใจที่อยู่นอกพื้นที่ ต้องตกลงค่าเดินทางก่อน |
| `CHAT_MESSAGE_FROM_FAMILY` | ข้อความใหม่จากครอบครัว |
| `JOB_SCHEDULED` | งานถูกนัดหมายแล้ว |

แต่ละแถวมี `title`, `body` (ภาษาไทย พร้อมแสดงตรง ๆ), `read_at`, `created_at`
และ id ของสิ่งที่มันพูดถึง — `care_request_id`, `caregiver_id`, `job_request_id`,
`job_id`, `chat_thread_id` — ใช้พาไปหน้าปลายทางได้เลยโดยไม่ต้องค้นหาใหม่

---

## 4. กฎที่หน้าบ้านต้องเคารพ

กฎเหล่านี้บังคับที่หลังบ้านแล้ว แต่ถ้าหน้าบ้านไม่แสดงให้ถูก ผู้ใช้จะสับสน

### 4.1 ตำแหน่งเปิดเผยเป็นสองระดับ

| ใครดู | เห็นอะไร |
|---|---|
| ผู้ดูแล **ก่อนตอบรับ** | `precision: "APPROXIMATE"` พิกัดปัดลงตาราง ~1 กม. รัศมี 900 ม. |
| ผู้ดูแล **หลังตอบรับ** | `precision: "EXACT"` พิกัดจริง + geofence |
| ครอบครัว | `EXACT` เสมอ (เป็นของตัวเอง) |

**ห้ามวางหมุดบนตำแหน่งแบบ APPROXIMATE** — หมุดสื่อว่า "บ้านอยู่ตรงนี้" ซึ่งไม่จริง ใช้วงกลมประอย่างเดียว

### 4.2 การจับคู่ต้องมีความยินยอมสองฝ่าย

คะแนนสูงไม่ได้แปลว่าจับคู่ · `MUTUAL_MATCH` เกิดเมื่อทั้งสองฝ่ายกดสนใจเท่านั้น
`status` ที่เป็นไปได้: `NONE` · `FAMILY_INTERESTED` · `CAREGIVER_INTERESTED` · `MUTUAL_MATCH` · `CAREGIVER_MUST_ACCEPT_DISTANCE`

### 4.3 ประตู Care Plan

ส่งคำขอไม่ได้ถ้ายังไม่มีตารางที่ยืนยันแล้ว → `409 CARE_PLAN_REQUIRED`
ข้อความที่ต้องแสดง: *"กรุณาสร้างและยืนยันรายการงานดูแลก่อนส่งคำขอไปยังผู้ดูแล"*
**ห้ามบังคับให้สร้างคำขอใหม่** — พากลับมาที่ผู้ดูแลคนเดิมที่เลือกไว้

### 4.4 งานนอกพื้นที่

- แสดง **แยกกลุ่ม** ห้ามปนกับอันดับปกติ ห้ามเป็นอันดับ 1
- ต้องแสดง `additional_cost_estimate` และคำว่า **"ประมาณการ"** — `is_final_price` เป็น `false` เสมอ
- ต้องยินยอมทั้งสองฝ่าย · ถ้าต้องมีที่พัก ต้องตกลงก่อนจึงจะยืนยันได้
- ระยะทางเป็นข้อยกเว้นเดียวที่ผ่อนได้ — เงื่อนไขบังคับอื่น ๆ ห้ามข้าม

### 4.5 กระดานประกาศไม่มี AI

`/app/board/*` ตอบ `scored: false` และไม่มี field คะแนนใด ๆ
**ห้ามหน้าบ้านเรียก matching มาใส่เอง** — การอ่านประกาศไม่ใช่จังหวะที่ใครขอให้ประเมิน
เงื่อนไขบังคับตรวจตอน **กดสมัคร** และตอบเป็นเหตุผลอ่านเข้าใจได้ใน `reasons[]`

### 4.6 การแจ้งเตือนบอกได้แค่เท่าที่หน้าจอบอก

`body` ของแจ้งเตือนถูกเขียนไว้ให้อยู่ระดับการเปิดเผยเดียวกับข้อ 4.1 —
ฝั่งผู้ดูแลที่ยังไม่ตอบรับจะเห็นแค่ **อำเภอ/จังหวัด วันที่ เวลา และค่าตอบแทน**
ไม่มีที่อยู่และไม่มีพิกัด ถ้าหน้าบ้านเอา `body` ไปแสดงตรง ๆ ก็ปลอดภัยอยู่แล้ว
**อย่าเติมข้อมูลจากที่อื่นเข้าไปในการ์ดแจ้งเตือน**

การรันแมตช์ซ้ำจะไม่แจ้งเตือนซ้ำ (`NEW_MATCHING_JOB` และ `NEW_EXCEPTIONAL_CANDIDATE`
ออกครั้งเดียวต่อคู่) — ถ้าเห็นซ้ำ แปลว่าเป็นคู่ใหม่จริง

### 4.7 AI ห้ามยุ่งกับตัวเลข

Match score · hard filter · trust score · สถานะ realtime — **คำนวณด้วยกฎทั้งหมด**
AI ใช้เรียบเรียงคำอธิบายจากคะแนนที่คำนวณเสร็จแล้วเท่านั้น
ถ้า AI ล่ม ระบบตอบ `ai_available: false` + `degraded_reason` — **ต้องแสดงให้ผู้ใช้รู้ ห้ามทำเหมือนสำเร็จ**

### 4.8 ข้อมูลที่ผู้ดูแลห้ามเห็นก่อนตอบรับ

ที่อยู่ · ประวัติแพ้ยา · อุปกรณ์การแพทย์ · เบอร์ติดต่อฉุกเฉิน · บันทึกส่วนตัว · พิกัดจริง
API กรองให้แล้ว — **อย่าดึงจาก endpoint อื่นมาเติม**

---

## 5. ตัวอย่าง response ที่ใช้บ่อย

### `POST /app/find-caregivers`

```json
{
  "ok": true,
  "care_request": { "id": "uuid", "code": null, "care_date": "2026-09-01" },
  "distance_options": {
    "search_radius_km": 200,
    "nearest": {
      "title": "เลือกคนที่อยู่ใกล้",
      "count": 3,
      "best": {
        "name": "นารี ใกล้บ้าน", "distance_km": 3, "compatibility": 97.3,
        "cost": { "base_rate": 1500, "travel": 0, "accommodation": 0,
                  "estimated_total": 1500, "label": "ไม่มีค่าใช้จ่ายเพิ่ม" }
      }
    },
    "best_fit_far": {
      "title": "เลือกคนที่เหมาะที่สุด แม้อยู่ไกล",
      "count": 1, "requires_both_to_agree": true,
      "best": {
        "name": "ฟาติมา ต่างจังหวัด", "distance_km": 144.98, "compatibility": 97.4,
        "cost": { "base_rate": 1500, "travel": 1740, "accommodation": 800,
                  "estimated_total": 4040, "is_final_price": false,
                  "label": "ประมาณการ ยังไม่ใช่ราคาสุดท้าย" }
      }
    },
    "recommendation": {
      "compatibility_gap": 1, "extra_cost": 2540,
      "summary": "คนที่อยู่ไกลเหมาะกว่า 1 คะแนน แต่มีค่าใช้จ่ายเพิ่มประมาณ 2,540 บาท"
    }
  },
  "matching": {
    "recommended_nearby": [{
      "caregiver_id": "uuid",
      "caregiver": { "display_name": "นารี ใกล้บ้าน", "years_experience": 9,
                     "final_trust_score": 92, "expected_rate": 900 },
      "base_family_fit": 97.5, "base_job_fit": 98.0, "base_mutual_fit": 97.3,
      "final_family_fit": 97.2, "final_job_fit": 97.9, "final_mutual_fit": 97.05,
      "distance_km": 3, "bucket": "RECOMMENDED_NEARBY", "exceptional_match": false,
      "why": [{ "reason": "ทักษะที่จำเป็นครบทั้งหมด", "feature": "skill_match_score", "value": 100 }],
      "concerns": [],
      "bucket_values": { "family": { "skill_match": 100, "trust_history": 92 } },
      "hard_filter_results": { "verification_status": { "pass": true } }
    }],
    "exceptional_matches": [],
    "filtered_out_count": 16,
    "filtered_out_reasons": [{ "filter": "mandatory_required_skill",
                               "label": "ไม่มีทักษะที่จำเป็น", "count": 11 }],
    "score_version": "matching-v4", "runtime_ms": 5
  }
}
```

### `POST /app/care-plan/draft`

ส่ง `{"text": "แปดโมงเช้าอาบน้ำ สิบเอ็ดโมงให้ยาเบาหวาน เที่ยงป้อนข้าว บ่ายสามพาเดิน"}`

```json
{
  "ok": true, "source": "AI",
  "items": [
    { "time": "08:00", "raw_time": "แปดโมงเช้า", "title": "อาบน้ำ",
      "task_code": "BATHING", "critical": false },
    { "time": "11:00", "raw_time": "สิบเอ็ดโมง", "title": "ให้ยาเบาหวาน",
      "task_code": "MEDICATION_REMINDER", "critical": true }
  ],
  "corrections": [],
  "ai": { "available": true, "degraded_reason": null }
}
```

`corrections[]` คือจุดที่ระบบตรวจพบว่า AI แปลงเวลาผิดแล้วแก้ให้ — **ควรแสดงให้ผู้ใช้เห็น**

### `409 NOT_ELIGIBLE` ตอนผู้ดูแลสมัครงาน

```json
{
  "ok": false, "error": "NOT_ELIGIBLE",
  "message": "ยังสมัครงานนี้ไม่ได้",
  "failed_filters": ["mandatory_required_skill"],
  "reasons": ["งานนี้กำหนดทักษะที่คุณยังไม่ได้ระบุไว้ในโปรไฟล์"],
  "hint": "ปรับเงื่อนไขของคุณในแท็บ \"ค้นหางานที่ต้องการ\" แล้วลองอีกครั้ง"
}
```

---

## 6. ค่าคงที่ที่ต้องใช้ทำ label

```
งาน (task_code)
MEAL_PREP เตรียมอาหาร · MEDICATION_REMINDER เตือนยา · BATHING อาบน้ำ · TOILETING ช่วยเข้าห้องน้ำ
DRESSING แต่งตัว · MOBILITY_SUPPORT พาเดิน · TRANSFER ยก/เคลื่อนย้าย · COMPANIONSHIP อยู่เป็นเพื่อน
HOUSEKEEPING งานบ้าน · HOSPITAL_ESCORT พาไปโรงพยาบาล · WOUND_CARE ทำแผล · NIGHT_MONITORING เฝ้ากลางคืน

ทักษะ (skill)
ELDERLY_CARE ดูแลผู้สูงอายุทั่วไป · DIABETES_CARE ดูแลเบาหวาน · DEMENTIA_CARE ดูแลสมองเสื่อม
MEDICATION การให้ยา · WOUND_CARE ทำแผล · TRANSFER เคลื่อนย้ายผู้ป่วย · ESCORT พาไปโรงพยาบาล

ภาวะ (condition)
DIABETES เบาหวาน · HYPERTENSION ความดัน · STROKE อัมพฤกษ์ · DEMENTIA สมองเสื่อม
HEART_DISEASE โรคหัวใจ · PRESSURE_ULCER_RISK เสี่ยงแผลกดทับ · PARKINSON พาร์กินสัน

การเคลื่อนไหว (mobility)
INDEPENDENT ช่วยเหลือตัวเองได้ · SUPERVISION ต้องมีคนคอยดู · WALKING_ASSIST เดินต้องประคอง
TRANSFER_ASSIST ต้องช่วยย้ายตัว · WHEELCHAIR ใช้รถเข็น · BEDBOUND ติดเตียง

สถานะติดตาม (care state)
NORMAL ปกติ · OBSERVE เฝ้าสังเกต · VERIFY ต้องตรวจสอบ · ATTENTION ต้องให้ความสนใจ · HIGH_RISK เสี่ยงสูง

เหตุการณ์ (event_type)
CHECK_IN · CHECK_OUT · TASK_STARTED · TASK_COMPLETED · TASK_DELAYED · GPS_UPDATE
GEOFENCE_EXIT · GEOFENCE_ENTER · ALERT_SENT · ALERT_ACK · ALERT_TIMEOUT · SOS · NOTE_ADDED

หมวดคะแนน (bucket)
skill_match ทักษะ · experience_condition_fit ประสบการณ์กับภาวะนี้ · schedule_fit ความพร้อมด้านเวลา
trust_history ความน่าเชื่อถือ · task_expectation_fit งานที่ต้องทำ · mobility_physical_fit การช่วยเคลื่อนไหว
budget_rate_fit ค่าบริการเทียบงบ · language_communication_fit ภาษา · continuity_fit ความต่อเนื่อง
care_style_preference_fit สไตล์การดูแล · distance_travel_fit ระยะทาง
```

---

## 7. เรื่องที่ควรรู้ก่อนเริ่ม

### id เป็น uuid แต่รับ code ได้

ข้อมูลตัวอย่างมี `code` อ่านง่าย (`CR-01`, `CG_NEAR_01`) API รับได้ทั้งสองแบบ —
`/api/matching/CR-01/run` กับ `/api/matching/<uuid>/run` ไปที่แถวเดียวกัน
**response คืน uuid เสมอ** ถ้าจะเทียบ id ให้เทียบ uuid

### เวลาเป็น `HH:MM:SS`

Postgres คืน `08:00:00` — ตัดเหลือ `HH:MM` ก่อนแสดง

### แผนที่

เว็บทดสอบใช้ Leaflet + OpenStreetMap ข้อควรระวังที่เจอ:
- ต้อง `setView()` **ก่อน**เพิ่ม layer ไม่งั้น `getBounds()` จะพัง
- container ที่ยังไม่มีขนาด (อยู่ใน accordion ที่ยังไม่กาง) ทำให้ `fitBounds()` พัง — เรียกใน `setTimeout` + try/catch
- ต้องรองรับกรณีโหลดแผนที่ไม่ได้ (แสดงพิกัดเป็นข้อความแทน)

### การอัดเสียง

ใช้ `MediaRecorder` → `POST /app/care-plan/transcribe` (raw body, header `x-filename`)
ต้องมีทางพิมพ์แทนเสมอ เพราะเบราว์เซอร์บางตัวอัดไม่ได้และผู้ใช้อาจไม่ให้สิทธิ์ไมค์

### Auth

เว็บทดสอบใช้ header `x-role` / `x-actor-id` เพื่อสลับบัญชีได้โดยไม่ต้อง login —
**ใช้ได้เฉพาะโหมดทดสอบ** (`DEV_TESTER_ENABLED`)
ของจริงต้องมี Supabase Auth ครอบ และ RLS ใน `db/migrations/002_rls.sql` คือสิ่งที่ปกป้องข้อมูลในโหมดนั้น

---

## 8. เอกสารอื่น

| ไฟล์ | เนื้อหา |
|---|---|
| `README.md` | ภาพรวมระบบ วิธีรัน โครงสร้าง |
| `docs/SCORING_SPEC.md` | สูตรคะแนนทั้งหมด น้ำหนัก เกณฑ์ ทุกตัวเลขที่ระบบใช้ |
| `test_Ai.md` | ผลการทดสอบและ benchmark |
| `db/README.md` | schema และวิธี apply |
| `docs/migration-audit.md` | บันทึกการสร้างระบบ |

คำถามเรื่องตัวเลขหรือกฎการให้คะแนน — ดู `SCORING_SPEC.md` เป็นหลัก ทุกอย่างอ้างอิงกลับไปที่ V4/V5/V6 ได้

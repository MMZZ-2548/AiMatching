# TrustCare — สรุปผลการทดสอบระบบ AI Matching

วันที่รัน 29 สิงหาคม 2026 · โครงสร้างรายงานตาม Testing & Benchmark Plan V6 §18

> **ข้อกำหนดสำคัญก่อนอ่านตัวเลข**
> เอกสาร V6 §0 ห้ามใช้คำว่า "AI Matching Accuracy xx%" เพราะไม่มีชุดข้อมูลใดในนี้ที่มี ground truth
> ว่าผู้ดูแลคนไหนคือคนที่ดีที่สุดจริง ตัวเลขทั้งหมดในรายงานนี้จึงเป็นอย่างใดอย่างหนึ่งใน 2 ประเภท คือ
> **ความถูกต้องของข้อจำกัด (constraint correctness)** หรือ **ความสอดคล้องกับกฎที่กำหนดไว้ (rule conformance)**
> ไม่มีตัวเลขใดเป็นความแม่นยำของการจับคู่

---

## สรุปหนึ่งหน้า

| ชั้นการทดสอบ | ผล | หลักฐานประเภท |
|---|---|---|
| Unit + API + E2E | **80/80 ผ่าน (100%)** | ระบบภายใน |
| Strathclyde — ข้อมูลจริง 6,805 visits | **0 double-booking · 0 shift violation · travel 100%** | PUBLIC_OPERATIONAL_BENCHMARK |
| HHCRSP — 341 instances / 66,952 tasks | **0 invalid assignment · constraint satisfaction 100%** | PUBLIC_ACADEMIC_BENCHMARK |
| HHCRSP — ตรวจซ้ำด้วย validator ของเจ้าของ dataset | **125/125 VALID (100%)** | ยืนยันอิสระ |
| TrustCare Controlled — 120 scenarios | **120/120 ผ่าน (100%)** | CONTROLLED_TEST |
| Supabase smoke — journey เต็มบน Postgres จริง | **25/25 ผ่าน (100%)** | ระบบภายใน |

---

## Section A — การทดสอบภายในระบบ

รันจริงด้วย Vitest + Supertest ผ่าน Express app ตัวจริง ไม่มีการ mock service ใด ยกเว้นเส้นทางที่เรียก
OpenAI ซึ่งถูกทดสอบว่า **ต้องรายงานว่าเรียกไม่ได้** ไม่ใช่แกล้งทำเป็นสำเร็จ

| | จำนวน |
|---|---|
| ไฟล์ทดสอบ | 2 |
| เทสต์ทั้งหมด | 80 |
| ผ่าน | **80** |
| ไม่ผ่าน | 0 |

**ครอบคลุมอะไรบ้าง**

- Hard filter ทั้ง 14 ตัวตาม V4 §14 (unit)
- สูตร Family Fit / Job Fit / Mutual Fit และการ normalize น้ำหนัก
- Exceptional far match ครบทุกเคสของ V5 §26 และ V6 Group E
- Trust score, การกันโทษจาก incident ที่ยังไม่ยืนยัน, cold-start shrinkage
- **E2E ฝั่งครอบครัวเริ่ม (V5 §15) ครบ 30 ขั้น** — matching → mutual match → ประตู Care Plan → ส่งคำขอ → ยอมรับ → chat → check-in/out → รายงาน → รีวิว → trust อัปเดต → matching รอบถัดไปเห็นประวัติ
- **E2E ฝั่งผู้ดูแลเริ่ม (V5 §16)** — เจองานเอง → สนใจ → ครอบครัวตอบรับ → mutual match
- **E2E งานนอกพื้นที่** — ต้องยินยอมทั้งสองฝ่าย และต้องตกลงเรื่องที่พักก่อนปิดงานได้
- Rule engine ของ realtime monitoring — SOS, geofence, GPS ความแม่นยำต่ำ, duplicate event, out-of-order event
- **การสลับ role ต้องไม่ล้าง state** (V5 §14) — ทดสอบจริงโดยยิง API สลับ `x-role` กลางคัน

### ทดสอบบนฐานข้อมูลจริง (Supabase)

`scripts/supabase_smoke.js` เดิน journey สองฝั่งครบหนึ่งรอบบน Postgres จริง แล้วตรวจสิ่งที่บันทึกลงจริง

| | ผล |
|---|---|
| ข้อตรวจ | 25 |
| ผ่าน | **25** |
| ไม่ผ่าน | 0 |

ครอบคลุม: seed 45 แถว → matching (persist feature values ครบ) → exceptional far match (148.72 กม.,
base 91.96, ค่าใช้จ่ายเพิ่ม 2,585 บาท ระบุว่าเป็นประมาณการ) → privacy-safe job card →
mutual match สองฝ่าย → ประตู Care Plan → job request → accept พร้อมเหตุผล 7 ข้อที่อ้าง feature ได้ทุกข้อ →
chat สองทาง → SOS → HIGH_RISK → GPS แม่นยำต่ำไม่ escalate → review อัปเดต trust (82.5) →
incident ที่ยังไม่ยืนยันไม่หักคะแนน → ยืนยันแล้วหัก (82.5 → 80) → matching รอบถัดไปเห็นประวัติ

**หมายเหตุเรื่องการทดสอบ:** ชุดเทสต์ 80 ตัวรันบน in-process store เพราะ `beforeEach` ต้อง reset
38 ตารางทุกเทสต์ ถ้าชี้ไปที่ Supabase จะยิง HTTP หลายพันครั้งจนการเชื่อมต่อหมด (ลองแล้วได้
`TypeError: fetch failed` 21 ตัว ซึ่งไม่ได้บอกอะไรเกี่ยวกับระบบเลย) การตรวจ Supabase จึงใช้
smoke test ที่ seed ครั้งเดียวเดินรอบเดียว ซึ่งเหมาะกับงานนี้กว่า

---

## Section B — Public Operational Benchmark

**Dataset of Home Care Scheduling and Routing Problems with Synchronized Visits**
University of Strathclyde, UK · DOI `10.15129/2d4885e1-bc24-414b-83ce-a846fb5c9689`
ข้อมูลปฏิบัติการจริงจากผู้ให้บริการ home care ในเมืองใหญ่ของอังกฤษ 1–14 ตุลาคม 2017

ขนาดข้อมูล: **138 carers · 6,805 visits · 236 ผู้รับบริการ · travel matrix 236×236**

### ตัวเลขที่พิสูจน์ระบบ

| Metric | ผล |
|---|---|
| **Double bookings** | **0** |
| **Shift containment violations** | **0** |
| **Time-window violations** | **0** (0%) |
| **Travel feasibility** | **100%** จาก 4,213 legs |
| **Assignment constraint pass rate** | **100%** |
| Scheduling feasibility | 60.5% |
| Synchronized visit success | 906/1,493 (60.7%) |
| Runtime | 57.9 วินาที |
| Latency p50/p95/p99 ต่อ visit | 5.71 / 24.23 / 50.14 ms |

### สิ่งที่ต้องพูดตรง ๆ บนเวที

ตัวเลข **60.5%** ไม่ใช่ข้อจำกัดของ constraint logic แต่เป็นข้อจำกัดของ **greedy scheduler** ที่ทีมเขียนไว้
เพื่อขับ benchmark นี้ ผมตรวจแล้วว่าชั่วโมงงานของ carer มีมากกว่าความต้องการถึง **1.56 เท่า** (4,823 ชม.
ต่อ 3,100 ชม.) คนไม่ได้ขาด แต่งาน home care กระจุกตัวหนักที่ช่วงเช้า กลางวัน และเย็น greedy จึงจัดไม่ลง
ในช่วง peak นี่ไม่ใช่การทดสอบหา optimal solution และห้ามนำไปเทียบกับ published solutions ของ dataset

**ตัวเลขที่พิสูจน์ TrustCare จริงคือ 5 บรรทัดแรกที่เป็น 0 และ 100%** เพราะมันบอกว่าเมื่อระบบจัดคน
ระบบไม่เคยสร้าง assignment ที่ผิดกติกาแม้แต่ครั้งเดียวใน 4,000+ การจัด

### สิ่งที่ dataset นี้ไม่มี (มาร์กเป็น `NOT_AVAILABLE_IN_DATASET` ไม่แต่งขึ้น)

| ไม่มี | ผลกระทบ |
|---|---|
| **time window** | CSV มีแค่ `Time` เดียวกับ `Duration` ไม่มีช่วงเวลา → **สมมติเป็น ±30 นาที** และทุกที่ที่รายงานตัวเลข time-window ต้องกำกับว่าเป็นสมมติฐาน |
| **ตำแหน่งบ้าน carer** | matrix เป็น user↔user ล้วน → วัด travel ได้เฉพาะระหว่างงานต่อเนื่อง ไม่ใช่จากบ้านไปงานแรก |
| **flag synchronized** | ไม่มี field ตรง ๆ → อนุมานจาก `CarerCount = 2` (1,493 จาก 6,805 visits) |
| skills, ภาษา, งบ, trust, preference | **ห้ามใช้ dataset นี้ทดสอบ Family Fit / Job Fit / Mutual Fit** ตาม V6 §2 |

---

## Section C — Public Academic Constraint Benchmark

**Data and Toolbox Repository for the Home Healthcare Routing and Scheduling Problem (HHCRSP)**
Intelligent Optimization Laboratory, Università degli Studi di Udine, Italy
`https://github.com/iolab-uniud/hhcrsp` · Paper DOI `10.1111/itor.13585` · MIT License

ขนาด: **341 instances** (mankowska 70 + kummer 158 + Italian 113) · **66,952 tasks** · จัดได้ 63,589

### ตัวเลขที่พิสูจน์ระบบ

| Metric | ผล |
|---|---|
| **Invalid skill/service assignment** | **0 (0%)** |
| **Constraint satisfaction rate** | **100%** |
| **Time-window pass rate** | **100%** |
| **Caregiver overlaps** | **0** |
| **Synchronization pass rate** | **13,833/13,833 = 100%** |
| **Route validity** | **100%** จาก 63,589 legs |
| **Failures by rule** | **{} (ไม่มีเลย)** |
| Mandatory service coverage | 94.98% |
| Runtime | 97 วินาที |

### ✅ ตรวจซ้ำด้วย validator ของเจ้าของ dataset (หลักฐานที่แข็งที่สุด)

repo ของ Udine มี **Python validator ของตัวเอง** ที่ทีมเราไม่ได้เขียน V6 §3 ระบุ
"Validator Pass Rate" เป็น metric และนี่คือเหตุผลหลักที่เลือก HHCRSP ตั้งแต่แรก

| | |
|---|---|
| ส่ง solution ให้ตรวจ | 341 |
| ตรวจได้ | 125 |
| **VALID** | **125** |
| INVALID | **0** |
| ข้าม (จัดคนไม่ครบทุก patient) | 216 |
| **Validator pass rate** | **100%** |

validator บังคับว่าต้องจัดคนครบทุก patient ก่อนจึงจะยอมตรวจ instance นั้น จึงตรวจได้เฉพาะ
125 instance ที่ greedy ของเราคุมได้ 100% ส่วนที่เหลือรายงานว่า **ข้าม** ไม่ได้นับเป็นผ่าน

**ข้อสำคัญ:** การตัดสินว่า caregiver มีสิทธิ์ทำ service นั้นหรือไม่ ใช้ `runHardFilters` ซึ่งเป็น
**โค้ดตัวเดียวกับที่ระบบจริงใช้** ไม่ได้เขียนตรรกะแยกสำหรับ benchmark

จากตัวเลข 0 invalid assignment ใน 63,589 การจัดงาน ยืนยันได้ว่า **ระบบไม่เคยจับ caregiver ไปยังงานที่
service/skill requirement ไม่ตรง** ซึ่งเป็นสิ่งที่ V6 §3 ขอให้พิสูจน์โดยตรง

### ข้อควรระวัง

- coverage 94.98% เป็นผลของ greedy policy ไม่ใช่ผลของ constraint logic เช่นเดียวกับ Strathclyde
- Synchronization: มี 14,679 patient ที่ต้องการผู้ดูแลพร้อมกัน greedy จัดคนไม่ได้ 846 ราย
  แต่ **ในรายที่จัดคนได้ ข้อจำกัด synchronization ถูกต้อง 100%** — ไม่ได้จัดผิด แค่ไม่ได้จัด
- V6 §3 กำหนดว่า service code `s1..sN` **ไม่มีความหมายทางคลินิก** ในชุดข้อมูลนี้ ใช้เป็น
  service compatibility proxy เท่านั้น ห้ามอ้างว่า s1 = โรคหรือทักษะเฉพาะชนิดใด

---

## Section D — TrustCare Controlled Mutual Matching

**LABEL: `CONTROLLED_TEST`** — ทีมสร้างเองเพื่อทดสอบ rule/ranking conformance
**ไม่ใช่ real-world validation** (V6 §4)

120 scenarios แบ่งตาม V6 §5 พอดี: A 30 · B 25 · C 25 · D 20 · E 10 · F 10
สร้างด้วย deterministic seed `20260831` — regenerate แล้วได้ไฟล์เหมือนเดิมทุกไบต์

### ผล: 120/120 ผ่าน (100%)

| กลุ่ม | Metric | ผล |
|---|---|---|
| **A** Hard filter | Hard filter accuracy | **100%** |
| **B** Family Fit | Pairwise ranking agreement | **100%** |
| | Score stability | **100%** |
| **C** Job Fit | Job ranking agreement | **100%** |
| | Preference constraint pass | **100%** |
| | **Invalid recommendation rate** | **0%** |
| **D** Mutual Fit | Mutual formula agreement | **100%** |
| | One-sided bias test | **100%** |
| | Two-direction symmetry | **100%** |
| **E** Exceptional | Exceptional match rule accuracy | **100%** |
| | **Safety override accuracy** | **100%** |
| | Additional cost disclosure pass | **100%** |
| **F** Trust | **Trust penalty false positive rate** | **0%** |
| | Rebook signal pass | **100%** |
| | Cold-start conformance | **100%** |
| | Latency p50/p95/p99 | 0.09 / 0.29 / 1.06 ms |

### ความหมายของตัวเลขสำคัญ 3 ตัว

- **Invalid recommendation rate 0%** — ไม่เคยเสนองานที่ผู้ดูแลรับไม่ได้ให้ผู้ดูแลเลย (13 เคสทดสอบ
  ครอบคลุมทั้งงานกลางคืนที่เขาไม่รับ, งานยกเคลื่อนย้ายที่เขาปฏิเสธ, งานต่ำกว่าค่าจ้างขั้นต่ำ, งานนอกรัศมี,
  งานที่ทักษะไม่ถึง, งานชนกับงานที่รับไว้แล้ว)
- **Safety override accuracy 100%** — ข้อยกเว้นเรื่องระยะทางไม่เคยลบล้าง hard filter ด้านความปลอดภัย
  ตาม V5 §25 (ผู้ดูแลที่ขาดทักษะบังคับ ต่อให้เก่งแค่ไหนและ opt-in ครบ ก็ยังถูกกรองออก)
- **Trust penalty false positive rate 0%** — เหตุการณ์ที่ยังไม่ยืนยัน หรือยืนยันแล้วแต่ไม่ใช่ความผิด
  ผู้ดูแล ไม่เคยทำให้ Trust Score ลดลง ตาม V4 §34

### ข้อจำกัดที่ต้องยอมรับ

ทั้ง 120 เคสนี้ทีมเป็นคนเขียน expected label เอง ตัวเลข 100% จึงหมายความว่า
**"ระบบทำงานตรงตามที่สเปกเขียนไว้"** ไม่ได้หมายความว่า **"ระบบเลือกผู้ดูแลได้ดีในโลกจริง"**
บนสไลด์ต้องใช้คำว่า **rule conformance** ไม่ใช่ accuracy

---

## บั๊กจริงที่เจอระหว่างการทดสอบ (แก้แล้วทั้งหมด)

การทดสอบไม่ได้ผ่านหมดตั้งแต่รอบแรก — นี่คือสิ่งที่มันจับได้

| # | ปัญหา | ผลกระทบถ้าไม่เจอ | จับได้จาก |
|---|---|---|---|
| 1 | ผู้สมัครที่ตกทั้ง distance และ filter อื่น ไม่คืนเหตุผลออกมาเลย | หน้า Matching Debug (V5 §28) จะว่างเปล่า อธิบายให้ผู้ใช้ไม่ได้ | unit test E05 |
| 2 | `skill_level_fit` และ `experience_match` clamp ที่ระดับขั้นต่ำ | ผู้ดูแล level 5 ได้คะแนนเท่ากับ level 2 และคนประสบการณ์ 12 ปีเท่ากับ 2 ปี → ranking เพี้ยน | controlled B03/B04 |
| 3 | parse `distance.csv` เหลื่อมไปหนึ่งคอลัมน์ | ระยะทางทั้ง benchmark ผิดหมดโดยไม่มีสัญญาณเตือน | ตรวจเทียบค่าดิบ 6 จุด |
| 4 | generator ตัด field `jobs`/`inputs`/`trust_input` ทิ้งตอนเขียน JSONL | เคส 45 ตัวใน group C/D/F รันไม่ได้ | benchmark รอบแรก |
| 5 | **caregiver ที่รับงาน CR-01 ไปแล้ว ถูกกันออกจากการ match ของ CR-01 เอง** | รัน matching ซ้ำเมื่อไหร่ ผู้ดูแลที่ทำงานอยู่จะหายไปทุกครั้ง | E2E ขั้นที่ 30 |
| 6 | **อ่าน distance matrix ของ HHCRSP กลับด้าน** (สมมติว่า office อยู่ท้าย แต่จริง ๆ อยู่ index 0) | ระยะทางผิดทั้ง benchmark ตารางที่สร้างออกมาเดินทางไม่ทันจริง | validator ของ Udine |
| 7 | **ไม่ได้ implement ช่วงห่างเวลาของ sequential synchronization** (`distance: [min,max]`) | ตารางที่มี service ต่อเนื่องผิดข้อกำหนดของ dataset ทั้งหมด | validator ของ Udine |

### บทเรียนสำคัญที่สุดจากรอบนี้

**ข้อ 6 และ 7 audit ที่ผมเขียนเองจับไม่ได้เลย** — และรายงานว่า "route validity 100%" ทั้งที่ผิด
เหตุผลคือ audit ของผมเรียก `distanceBetween` **ตัวเดียวกับที่ scheduler ใช้** เมื่อ index ผิด
ทั้งสองฝั่งจึงผิดตรงกันอย่างสอดคล้อง และดูเหมือนถูก

**validator ของเจ้าของ dataset ซึ่งไม่ใช้โค้ดร่วมกับเราเลย จับได้ทันที** นี่คือเหตุผลที่ V6 §3
กำหนดให้ใช้ validator ภายนอก และเป็นเหตุผลที่ตัวเลขในหัวข้อ "ตรวจซ้ำด้วย validator" มีน้ำหนัก
มากกว่าตัวเลขที่เราตรวจตัวเอง

**ข้อ 5 เป็นตัวที่ unit test จับไม่ได้** ต้องรัน E2E ครบ 30 ขั้นตามที่ V5 §15 กำหนดถึงจะเจอ

### เรื่องที่ตอนแรกเข้าใจผิด

ระหว่างทดสอบ Smart Intake ผลออกมาว่าสกัด "เบาหวาน" และ "เดินต้องประคอง" ไม่ได้ ซึ่งขัดกับ V4 §42
ผมสรุปตอนแรกว่าเป็นปัญหาของ prompt แต่ตรวจต่อพบว่า **ต้นเหตุจริงคือ `curl` บน Git Bash ทำข้อความไทยเพี้ยน**
ไม่ใช่บั๊กของระบบ เมื่อเรียกผ่าน client ที่จัดการ UTF-8 ถูกต้อง ผลตรงตาม V4 §42 ทุก field

---

## ผลการทดสอบ Smart Intake กับ OpenAI จริง

ทดสอบด้วยประโยคตัวอย่างจาก V4 §42 ตรง ๆ:

> "พรุ่งนี้อยากได้ผู้หญิงดูแลแม่ 8 โมงถึง 4 โมง แม่เป็นเบาหวาน เดินต้องประคอง งบ 900"

| Field | คาดหวังตาม V4 §42 | ได้จริง | |
|---|---|---|---|
| care_date | พรุ่งนี้ → วันที่จริง | `2026-08-30` | ✓ |
| start_time / end_time | 08:00 / 16:00 | `08:00` / `16:00` | ✓ |
| conditions | diabetes | `["DIABETES"]` | ✓ |
| mobility | WALKING_ASSIST | `WALKING_ASSIST` | ✓ |
| budget | 900 | `900` | ✓ |
| gender preference | female | `{"gender":"FEMALE"}` | ✓ |
| missing tasks detected | ต้องตรวจพบ | `["requested_tasks"]` | ✓ |
| follow-up question | ถามเรื่อง task | "ต้องการให้ช่วยเรื่องอะไรบ้าง เช่น อาบน้ำ เตือนยา เตรียมอาหาร หรือพาเดินครับ?" | ✓ |

ตั้ง `temperature = 0` สำหรับงานสกัดข้อมูล เพื่อให้ประโยคเดียวกันได้ผลเดิมทุกครั้ง

**ข้อจำกัด:** ส่วนนี้พึ่งพาโมเดลภายนอก ผลไม่ deterministic เท่า matching engine จึง**ไม่ถูกนับรวม
ในตัวเลข conformance ใด ๆ** ในรายงานนี้

---

## เส้นแบ่งที่ระบบรักษาไว้ตลอด

V4 §0 และ §4 ห้าม GPT ยุ่งกับตัวเลข 4 อย่าง ระบบนี้บังคับด้วยสถาปัตยกรรม ไม่ใช่ด้วยความตั้งใจ:

| GPT ห้ามทำ | บังคับอย่างไร |
|---|---|
| สร้าง Match Score | matching engine เป็น pure function ไม่มี network call เลย |
| ตัดสิน Hard Filter | `hardFilters.js` ไม่ import อะไรที่เกี่ยวกับ AI |
| คำนวณ Trust Score | `trust.js` เป็นเลขคณิตล้วน |
| ตัดสิน realtime state | `monitoring.js` เป็น rule engine ไม่มี network call |

GPT ทำได้อย่างเดียวคือ **เรียบเรียงคำอธิบายจาก score breakdown ที่คำนวณเสร็จแล้ว** และ endpoint
`/api/matching/explain` **ส่งคะแนนกลับจากฝั่ง deterministic เสมอ** ไม่เคยอ่านตัวเลขจากคำตอบของโมเดล

เมื่อ AI ใช้ไม่ได้ ระบบตอบว่าใช้ไม่ได้ (`ai_available: false` + `degraded_reason`) ไม่แกล้งทำเป็นสำเร็จ
ตาม V4 §52 — มี test ยืนยันข้อนี้โดยเฉพาะ

---

## ข้อจำกัดทั้งหมด (Section E ตาม V6 §18)

1. ไม่มีชุดข้อมูลใดที่มี ground truth ว่าผู้ดูแลคนไหนดีที่สุดจริง จึงไม่มีการอ้าง accuracy ใด ๆ
2. Strathclyde ไม่มี time window — สมมติเป็น ±30 นาที ตัวเลข time-window ทุกตัวขึ้นกับสมมติฐานนี้
3. Strathclyde ไม่มีตำแหน่งบ้าน carer — วัด travel ได้เฉพาะระหว่างงานต่อเนื่อง
4. Strathclyde ไม่มี flag synchronized — อนุมานจาก CarerCount = 2
5. ทั้ง Strathclyde และ HHCRSP **ไม่มี** skill level, ภาษา, งบประมาณ, trust หรือ preference จึง
   **ไม่ได้พิสูจน์ Family Fit / Job Fit / Mutual Fit เลย** ส่วนนั้นพิสูจน์ด้วย Controlled Test เท่านั้น
6. HHCRSP service code เป็น compatibility proxy ไม่มีความหมายทางคลินิก
7. Scheduling feasibility และ service coverage สะท้อน greedy policy ไม่ใช่ optimiser
   เทียบกับ published optimal solutions ไม่ได้
8. validator ของ HHCRSP ตรวจได้เฉพาะ instance ที่จัดคนครบทุก patient จึงตรวจได้ 125 จาก 341
   ส่วนที่เหลือรายงานว่าข้าม ไม่ได้นับเป็นผ่าน
9. Controlled 120 เคสทีมเขียนเอง ทดสอบความสอดคล้องกับสเปก ไม่ใช่ผลลัพธ์ในโลกจริงหรือความพึงพอใจผู้ใช้
10. **Supabase schema เขียนและตรวจแล้วแต่ยังไม่ได้ apply** — การรัน DDL ต้องใช้รหัสผ่านฐานข้อมูลหรือ
   management token ซึ่งมีแค่ service key จึงทำไม่ได้ benchmark และ E2E ทั้งหมดรันบน in-process store
   ที่บังคับกฎเดียวกัน (ดู `db/README.md` สำหรับวิธี apply)
11. Smart Intake, Care Advisor และ report structuring พึ่งโมเดลภายนอก ไม่ deterministic
    และไม่ถูกนับในตัวเลข conformance ใด ๆ

---

## PRE_TUNING / POST_TUNING (V6 §14)

ตัวเลขทั้งหมดในรายงานนี้อยู่ในสถานะ **`PRE_TUNING`**

V6 §14 ห้ามปรับน้ำหนักโดยดู expected label แล้วเรียกผลว่าเป็น independent validation
ระหว่างพัฒนามีการแก้ 2 จุด และทั้งสองจุด**ไม่ได้แตะน้ำหนัก threshold หรือสูตร mutual fit เลย**:

1. นิยาม `skill_level_fit` และ `experience_match` ซึ่งสเปกเดิมไม่ได้กำหนดวิธีแปลงเป็น 0–100
   (เป็นการเขียนสเปกให้ครบ ไม่ใช่การจูน)
2. แก้บั๊กที่ exceptional evaluator ไม่ถูกเรียกเมื่อ candidate ตกหลาย filter (ผลลัพธ์เดิมถูกอยู่แล้ว
   ขาดแค่คำอธิบาย)

น้ำหนักทั้งหมดใน SCORING_SPEC §4–§8 เป็นค่าที่ derive จาก V4/V5 ตั้งแต่ต้นและไม่เคยเปลี่ยน
ทุก matching run บันทึก `score_version` และ `weight_version` ไว้ ถ้าอนาคตมีการปรับน้ำหนัก
ต้องรายงานเป็น `POST_TUNING_REGRESSION` และห้ามเรียกว่า independent

---

## ตัวเลขที่แนะนำให้ขึ้น Main Slide (V6 §19)

เลือก 3–5 ตัว ไม่ต้องโชว์หมด

**Public Benchmark**
> University of Strathclyde — ข้อมูล home care จริง 6,805 visits
> - Double bookings: **0**
> - Time-window violations: **0**
> - Travel feasibility: **100%**
>
> University of Udine HHCRSP — 341 instances, 66,952 tasks
> - Invalid skill/service assignments: **0**
> - Constraint satisfaction: **100%**
> - ตรวจซ้ำด้วย validator ของเจ้าของ dataset: **125/125 VALID**

**Controlled Mutual Matching**
> TrustCare 120 scenarios
> - Hard-filter conformance: **100%**
> - Invalid recommendations: **0**
> - Safety override accuracy: **100%**

---

## สคริปต์พูด (ปรับจาก V6 §20)

> "เราไม่ได้ทดสอบ Matching ด้วยข้อมูลที่ทีมสร้างเองอย่างเดียวครับ
>
> ส่วนข้อจำกัดด้านเวลา การเดินทาง และตารางงาน เราใช้ชุดข้อมูล Home Care จริงจาก University of
> Strathclyde ซึ่งมาจากผู้ให้บริการ home care จริงในอังกฤษ 6,805 visits ผลคือระบบไม่สร้าง
> double-booking เลยแม้แต่ครั้งเดียว และไม่ละเมิดกรอบเวลาหรือความเป็นไปได้ของการเดินทางเลย
>
> ส่วน service requirement และ time window เราใช้ HHCRSP จาก University of Udine 341 instances
> เกือบ 67,000 งาน ผลคือ **ไม่มีการจับ caregiver ไปยังงานที่ทักษะไม่ตรงเลยแม้แต่ครั้งเดียว**
>
> และเราไม่ได้ตรวจเอง ชุดข้อมูลนี้มี validator ของทีมที่สร้างมันมาให้ด้วย เราเอาตารางที่ระบบเรา
> จัดออกมาส่งให้ validator ตัวนั้นตรวจ ผ่าน 125 จาก 125 instance ที่ตรวจได้
>
> แต่ public dataset เหล่านี้ไม่มีข้อมูล mutual preference งบประมาณ workload และ trust history
> แบบ TrustCare ทีมจึงสร้าง Controlled Mutual Matching 120 scenarios แยกอีกชุด เพื่อทดสอบ
> logic เฉพาะของระบบ ผ่าน 120 จาก 120
>
> เราแยกผล Public Benchmark กับ Controlled Test ชัดเจน และเราไม่เรียกตัวเลขชุดหลังว่า accuracy
> เพราะไม่มีชุดข้อมูลไหนบอกได้ว่าผู้ดูแลคนไหนดีที่สุดจริงครับ"

---

## วิธีรันซ้ำทั้งหมด

```bash
# 1. ทดสอบระบบภายใน (unit + API + E2E)
cd backend && npm install && npx vitest run

# 2. สร้าง controlled dataset 120 เคส (deterministic seed)
node scripts/generate_controlled_mutual_dataset.js

# 3. รัน benchmark ทั้งสามชุด
node scripts/run_controlled_matching_benchmark.js
node scripts/run_strathclyde_benchmark.js
node scripts/run_hhcrsp_benchmark.js all
python scripts/run_hhcrsp_validator.py               # ตรวจซ้ำด้วย validator ของ Udine

# 4. รวมรายงาน
node scripts/aggregate_benchmark_results.js

# 5. เปิดเว็บทดสอบ
cd backend && node src/server.js      # http://localhost:3000/api/health
STORE=supabase node src/server.js     # ใช้ Supabase จริง

# 7. ตรวจบนฐานข้อมูลจริง
STORE=supabase node scripts/supabase_smoke.js

# 6. AI service (ต้องมี OPENAI_API_KEY ใน .env)
cd ai-service && python -m uvicorn app.main:app --port 8000
```

## ไฟล์ผลลัพธ์

| ไฟล์ | เนื้อหา |
|---|---|
| `reports/final_matching_validation_summary.md` | รายงานรวมตามโครง V6 §18 |
| `reports/benchmark_summary.md` | เหมือนข้างบน |
| `reports/controlled_mutual_results.{json,csv}` | ผลรายเคสทั้ง 120 |
| `reports/strathclyde_results.{json,csv}` | ผล operational benchmark |
| `reports/hhcrsp_results.{json,csv}` | ผลรายวินิจฉัย 341 instances |
| `reports/hhcrsp_validator_results.json` | ผลจาก validator ของเจ้าของ dataset |
| `reports/hhcrsp_solutions/` | solution JSON รูปแบบเดียวกับ repo ต้นทาง |
| `data/trustcare_controlled_mutual_120.{jsonl,csv}` | ชุดทดสอบ 120 เคส |
| `docs/SCORING_SPEC.md` | สูตรและน้ำหนักทั้งหมดที่ระบบใช้ |
| `docs/FRONTEND_HANDOFF.md` | เอกสารส่งต่อให้ทีมหน้าบ้าน — หน้าจอที่เคยมี API และกฎที่ต้องเคารพ |

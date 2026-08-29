<div align="center">

# TrustCare AI

**ระบบจับคู่ผู้ดูแลผู้สูงอายุแบบสองทาง — Mutual Care Matching Platform**

Backend Service · Node.js 22 · Python 3.12 · Supabase PostgreSQL

<br>

| ชั้นการทดสอบ | ผลลัพธ์ |
|:---|:---:|
| Unit · API · End-to-End | **151 / 151** |
| Controlled Mutual Matching (120 scenarios) | **120 / 120** |
| Strathclyde — ข้อมูลจริง 6,805 visits | **0 ข้อผิดพลาด** |
| HHCRSP — 341 instances · 66,952 tasks | **0 invalid assignment** |
| Validator อิสระของเจ้าของชุดข้อมูล | **125 / 125 VALID** |
| Supabase smoke test (Postgres จริง) | **31 / 31** |
| Acceptance Criteria (V6 §22) | **12 / 12** |

</div>

---

## สารบัญ

1. [ระบบนี้คืออะไร](#1-ระบบนี้คืออะไร)
2. [เริ่มต้นใช้งาน](#2-เริ่มต้นใช้งาน)
3. [สถาปัตยกรรม](#3-สถาปัตยกรรม)
4. [หลักการให้คะแนน](#4-หลักการให้คะแนน)
5. [ผลการทดสอบทั้งหมด](#5-ผลการทดสอบทั้งหมด)
6. [ที่มาของข้อมูลที่ใช้ทดสอบ](#6-ที่มาของข้อมูลที่ใช้ทดสอบ)
7. [ข้อจำกัดที่ต้องระบุเมื่อนำเสนอ](#7-ข้อจำกัดที่ต้องระบุเมื่อนำเสนอ)
8. [เส้นแบ่งที่ระบบรักษาไว้](#8-เส้นแบ่งที่ระบบรักษาไว้)
9. [โครงสร้างโปรเจกต์](#9-โครงสร้างโปรเจกต์)
10. [การตั้งค่า](#10-การตั้งค่า)
11. [ฐานข้อมูล](#11-ฐานข้อมูล)
12. [การส่งมอบ](#12-การส่งมอบ)

---

## 1. ระบบนี้คืออะไร

TrustCare เป็นแพลตฟอร์มจับคู่ **ครอบครัว ↔ ผู้ดูแลผู้สูงอายุ** ที่ทำงานสองทางจริง

ไม่ใช่แค่ครอบครัวหาผู้ดูแล แต่ผู้ดูแลก็ค้นหาและเลือกงานที่เหมาะกับตัวเองได้เช่นกัน
การจับคู่เกิดขึ้นเมื่อ **ทั้งสองฝ่ายยินยอมตรงกัน** เท่านั้น — คะแนนสูงไม่ได้แปลว่าจับคู่

```
Family Fit  +  Caregiver Job Fit  =  Mutual Fit
```

### ความสามารถหลัก

| ด้าน | รายละเอียด |
|---|---|
| **Matching Engine** | 14 hard filters · 40 soft features · คำนวณสองทิศทาง · deterministic ทั้งหมด |
| **Two-sided Marketplace** | ครอบครัวหาคน / ผู้ดูแลหางาน / กระดานประกาศ / ข้อเสนอจากทั้งสองฝั่ง |
| **Exceptional Far Match** | คนที่เหมาะมากแต่อยู่ไกล แสดงแยกพร้อมประมาณการค่าเดินทางและที่พัก |
| **Daily Care Plan** | พูดภาษาไทยธรรมดา → AI จัดเป็นตารางเวลารายวัน |
| **Real-time Monitoring** | Rule engine 5 สถานะ · GPS · geofence · SOS · **ไม่ใช้ AI** |
| **Trust Score** | คำนวณจากพฤติกรรม รีวิว ใบรับรอง เหตุการณ์ · มี cold-start shrinkage |
| **AI Care Advisor** | ตอบคำถามจากคะแนนที่คำนวณจริง ไม่ได้เดา |

### สถานะ

> **นี่คือ backend อย่างเดียว** — ระหว่างพัฒนามีเว็บทดสอบเพื่อพิสูจน์ว่า flow ทำงานได้จริง
> เว็บนั้นถูกลบไปแล้วเพราะไม่ใช่ของที่ส่งมอบ
>
> ทุกหน้าจอที่เคยมี · API ที่แต่ละหน้าเรียก · กฎที่หน้าบ้านต้องเคารพ
> บันทึกไว้ครบใน **[`docs/FRONTEND_HANDOFF.md`](docs/FRONTEND_HANDOFF.md)**

---

## 2. เริ่มต้นใช้งาน

### ติดตั้งและรัน

```bash
# Backend API
cd backend
npm install
node src/server.js                        # http://localhost:3000

# AI Service (ต้องมี OPENAI_API_KEY ใน .env)
cd ai-service
pip install -r requirements.txt
python -m uvicorn app.main:app --port 8001
```

ตรวจว่าพร้อมใช้งาน:

```bash
curl http://localhost:3000/api/health
```

```json
{
  "ok": true,
  "status": "up",
  "env": { "OPENAI_API_KEY": "set", "SUPABASE_URL": "set", "score_version": "matching-v4" },
  "store": { "driver": "supabase", "counts": { "caregiver_profiles": 20 } },
  "ai_service": { "reachable": true }
}
```

### ข้อมูลตัวอย่าง

```bash
curl -X POST http://localhost:3000/api/dev/seed     # สร้างข้อมูลตัวอย่าง
curl -X POST http://localhost:3000/api/dev/reset    # ล้างแล้วสร้างใหม่
```

สร้าง **5 ครอบครัว · 5 ผู้สูงอายุ · 20 ผู้ดูแล · 15 คำขอ** ตาม Master Spec V4 §40

ผู้ดูแลที่ออกแบบมาเพื่อทดสอบเคสเฉพาะ:

| รหัส | ใช้ทดสอบ |
|---|---|
| `CG_NEAR_01` | เคสสมบูรณ์ · ห่าง 3 กม. · ทักษะครบ · trust 92 |
| `CG_FAR_PERFECT_01` | เหมาะมากแต่ห่าง 145 กม. — ทดสอบ exceptional match |
| `CG_FAR_NO_OPTIN` | เหมาะมาก ไกล แต่ไม่รับงานนอกพื้นที่ — **ต้องไม่ถูกแสดง** |
| `CG-12` | ทักษะครบแต่ยังไม่ยืนยันตัวตน — **ต้องถูกกรองออก** |
| `CG-08` | ทักษะพื้นฐานเท่านั้น — ทดสอบการถูกปฏิเสธ |

### รันการทดสอบ

```bash
cd backend && npx vitest run                          # 151 tests

node scripts/generate_controlled_mutual_dataset.js     # สร้าง 120 เคส (seed 20260831)
node scripts/run_controlled_matching_benchmark.js      # CONTROLLED_TEST
node scripts/run_strathclyde_benchmark.js              # PUBLIC_OPERATIONAL_BENCHMARK
node scripts/run_hhcrsp_benchmark.js all               # PUBLIC_ACADEMIC_BENCHMARK
python scripts/run_hhcrsp_validator.py                 # validator ของเจ้าของ dataset
node scripts/aggregate_benchmark_results.js            # รวมรายงาน

python scripts/validate_migrations.py                  # ตรวจ SQL ทั้งหมด
STORE=supabase node scripts/supabase_smoke.js          # 31 ข้อตรวจบน Postgres จริง
```

> **อย่าชี้ชุดเทสต์ไปที่ Supabase project ที่ใช้งานร่วมกัน** — `beforeEach` เรียก `reset()`
> ซึ่งลบข้อมูลทุกตาราง และการยิง HTTP หลายพันครั้งจะทำให้การเชื่อมต่อหมด
> ชุดเทสต์ออกแบบให้รันบน in-process store · การตรวจ Supabase ใช้ `supabase_smoke.js`

---

## 3. สถาปัตยกรรม

```
                     ┌──────────────────────────────┐
   your frontend ───▶│   Node Backend  :3000        │
                     │                              │
                     │  ┌────────────────────────┐  │
                     │  │  matching engine       │  │  pure functions
                     │  │  hard filters · scores │  │  ไม่มี network call
                     │  └────────────────────────┘  │
                     │  ┌────────────────────────┐  │
                     │  │  workflow              │  │  interest · consent
                     │  │  care plan · chat      │  │  care plan gate
                     │  └────────────────────────┘  │
                     │  ┌────────────────────────┐  │
                     │  │  notifications         │  │  13 ชนิด (V5 §29)
                     │  │  inbox สองฝั่ง         │  │  ไม่ใช้ AI
                     │  └────────────────────────┘  │
                     │  ┌────────────────────────┐  │
                     │  │  monitoring            │  │  rule engine
                     │  │  5 states · geofence   │  │  ไม่ใช้ AI
                     │  └────────────────────────┘  │
                     │  ┌────────────────────────┐  │
                     │  │  store  memory│supabase│  │
                     │  └────────────────────────┘  │
                     └───────────┬──────────────────┘
                                 │
                     ┌───────────▼──────────────────┐
                     │  Python AI Service  :8001    │   ภาษาอย่างเดียว
                     │  intake · care plan          │   ห้ามแตะตัวเลข
                     │  advisor · report · STT      │
                     └───────────┬──────────────────┘
                                 │
                          ┌──────▼──────┐
                          │  OpenAI API │
                          └─────────────┘
```

### สถิติโค้ด

| ภาษา | ไฟล์ | บรรทัด |
|---|---:|---:|
| JavaScript | 43 | 9,883 |
| Python | 7 | 1,036 |
| SQL | 8 | 1,811 |
| Markdown | 8 | 2,404 |
| **รวม** | **66** | **15,134** |

**91 API endpoints · 43 ตาราง · 36 RLS policies · 151 tests**

---

## 4. หลักการให้คะแนน

รายละเอียดทั้งหมดอยู่ใน **[`docs/SCORING_SPEC.md`](docs/SCORING_SPEC.md)** — ทุกตัวเลขอ้างอิงกลับไปที่ V4/V5/V6 ได้

### ขั้นตอนการคำนวณ

```
                  ┌──────────────────┐
care_request ────▶│  1. HARD FILTERS │──▶ ไม่ผ่าน ──▶ filtered_out
caregiver    ────▶└────────┬─────────┘
                           │ ผ่านทั้ง 14 ข้อ
                           ▼
              ┌────────────────────────────┐
              │  2. FEATURE EXTRACTION     │  40 features → 0-100
              └────────────┬───────────────┘
                ┌──────────┴──────────┐
                ▼                     ▼
        base_family_fit         base_job_fit        ← ไม่รวมระยะทาง
                └──────────┬──────────┘
                           ▼
        base_mutual_fit = 0.60·Family + 0.40·Job
                           ▼
              ┌────────────────────────────┐
              │  3. ระยะทางกลับเข้ามา       │
              └────────────┬───────────────┘
                           ▼
                  final_mutual_fit
                           ▼
        ┌──────────────────┴──────────────────┐
        │  recommended_nearby │  exceptional  │
        └─────────────────────────────────────┘
```

### Hard Filters — 14 ข้อ (V4 §14)

ตกข้อใดข้อหนึ่ง = ไม่ถูกเสนอ · **GPT ไม่มีสิทธิ์ override**

| # | เงื่อนไข | # | เงื่อนไข |
|---|---|---|---|
| 1 | การยืนยันตัวตน | 8 | ภาษาที่บังคับ |
| 2 | ทักษะที่บังคับ | 9 | เพศที่บังคับ |
| 3 | ใบรับรองที่บังคับ | 10 | งานที่ผู้ดูแลปฏิเสธ |
| 4 | ระดับทักษะขั้นต่ำ | 11 | พาไปโรงพยาบาล |
| 5 | ความว่างและการชนงาน | 12 | ยกเคลื่อนย้าย |
| 6 | **รัศมีบริการ** ← soft ข้อเดียว | 13 | งบต่ำกว่าขั้นต่ำ |
| 7 | ความยาวกะ | 14 | งานอยู่ประจำ |

### น้ำหนัก Family Fit (V4 §18)

| หมวด | น้ำหนักเดิม | หลัง normalize |
|---|---:|---:|
| ทักษะที่ต้องการ | 20 | 22.222 |
| ประสบการณ์กับภาวะนี้ | 15 | 16.667 |
| ความพร้อมด้านเวลา | 12 | 13.333 |
| ~~ระยะทาง~~ | ~~10~~ | *ถอดออก — ดูด้านล่าง* |
| ความน่าเชื่อถือ | 10 | 11.111 |
| งานที่ต้องทำ | 8 | 8.889 |
| การช่วยเคลื่อนไหว | 7 | 7.778 |
| ค่าบริการเทียบงบ | 5 | 5.556 |
| ภาษาและการสื่อสาร | 5 | 5.556 |
| ความต่อเนื่องของงาน | 4 | 4.444 |
| สไตล์การดูแล | 4 | 4.444 |
| **รวม** | **100** | **100.000** |

**ทำไมถอดระยะทางออก** — V5 §20.3 กำหนดให้ทดสอบเกณฑ์ exceptional match กับคะแนน *"ก่อน distance penalty"*
ถ้าระยะทางฝังอยู่ในคะแนน จะทำเช่นนั้นไม่ได้ จึงถอดออก normalize กลับเป็น 100
แล้วค่อยนำกลับเข้ามาตอนคำนวณ `final` — **น้ำหนักของ V4 ไม่ถูกเปลี่ยน เปลี่ยนแค่ลำดับการคำนวณ**

### Exceptional Far Match (V5 §19–§27)

```
เป็น exceptional เมื่อ:
  ผ่าน hard filter ทุกข้อ ยกเว้นข้อ 6 (รัศมี)
  AND ทักษะบังคับครบ
  AND base_mutual_fit ≥ 90          ← ก่อนคิดระยะทาง
  AND ระยะทาง ≤ 300 กม.
  AND ผู้ดูแลเปิดรับงานนอกพื้นที่
  AND ครอบครัวเปิดรับคนนอกพื้นที่
```

- แสดง **แยกกลุ่ม** ห้ามปนกับอันดับปกติ ห้ามเป็นอันดับ 1
- ต้องแสดงประมาณการค่าเดินทาง + ค่าที่พัก และคำว่า **"ประมาณการ"** เสมอ
- ระยะทางเป็นข้อยกเว้นเดียวที่ผ่อนได้ — เงื่อนไขความปลอดภัยอื่นห้ามข้าม

---

## 5. ผลการทดสอบทั้งหมด

> ### ⚠️ ข้อกำหนดสำคัญก่อนอ่านตัวเลข
>
> Testing Plan V6 §0 **ห้ามใช้คำว่า "AI Matching Accuracy xx%"** เพราะไม่มีชุดข้อมูลใดที่มี
> ground truth ว่าผู้ดูแลคนไหนคือคนที่ดีที่สุดจริง
>
> ตัวเลขทั้งหมดเป็นอย่างใดอย่างหนึ่งใน 2 ประเภท:
> **ความถูกต้องของข้อจำกัด (constraint correctness)** หรือ
> **ความสอดคล้องกับกฎที่กำหนด (rule conformance)**
> — **ไม่มีตัวเลขใดเป็นความแม่นยำของการจับคู่**

### 5.1 การทดสอบภายในระบบ — 151/151

รันจริงด้วย Vitest + Supertest ผ่าน Express app ตัวจริง ไม่มีการ mock service ใด
ยกเว้นเส้นทางที่เรียก OpenAI ซึ่งถูกทดสอบว่า **ต้องรายงานว่าเรียกไม่ได้** ไม่ใช่แกล้งทำเป็นสำเร็จ

| กลุ่มการทดสอบ | จำนวน |
|---|---:|
| **การแปลงเวลาภาษาพูดไทย** | **44** |
| **การเปิดเผยตำแหน่งเป็นขั้น** | **14** |
| **การแจ้งเตือน 13 ชนิด (V5 §29)** | **13** |
| Hard filters (V4 §14 / V6 Group A) | 13 |
| Exceptional far match (V5 §19–27 / V6 Group E) | 9 |
| Trust score (V4 §34 / V6 Group F) | 7 |
| Mutual fit formula (V4 §20 / V6 Group D) | 6 |
| Monitoring rules (V4 §31, §44) | 6 |
| Matching API (V4 §22, V5 §3) | 6 |
| Family / Job fit ranking (V6 Group B, C) | 6 |
| Care request visibility (V5 §17) | 4 |
| E2E สองฝั่งครบวงจร (V5 §15, §16) | 4 |
| Caregiver job discovery (V4 §23, V5 §4) | 3 |
| Care plan gate · chat gate (V4 §24, §25) | 3 |
| อื่น ๆ (weights · determinism · health · seed) | 13 |
| **รวม** | **151** |

### 5.2 Strathclyde — `PUBLIC_OPERATIONAL_BENCHMARK`

ข้อมูลปฏิบัติการจริงจากผู้ให้บริการ home care ในอังกฤษ
**138 carers · 6,805 visits · 236 ผู้รับบริการ · travel matrix 236×236**

| ตัวชี้วัดที่พิสูจน์ระบบ | ผล |
|---|---:|
| **Double bookings** | **0** |
| **Shift containment violations** | **0** |
| **Time-window violations** | **0** |
| **Travel feasibility** (4,213 legs) | **100%** |
| **Assignment constraint pass rate** | **100%** |
| | |
| Scheduling feasibility | 60.5% |
| Synchronized visit success | 906 / 1,493 |
| Latency p50 / p95 / p99 | 1.73 / 12.45 / 23.89 ms |

**สิ่งที่ต้องพูดตรง ๆ บนเวที**

ตัวเลข **60.5%** เป็นข้อจำกัดของ greedy scheduler ที่เขียนขึ้นเพื่อขับ benchmark นี้
**ไม่ใช่ข้อจำกัดของ constraint logic** — ตรวจแล้วว่าชั่วโมงงานของ carer มีมากกว่าความต้องการ
**1.56 เท่า** (4,823 ชม. ต่อ 3,100 ชม.) คนไม่ได้ขาด แต่งาน home care กระจุกตัวที่ช่วง peak

**ตัวเลขที่พิสูจน์ TrustCare จริงคือ 5 บรรทัดแรกที่เป็น 0 และ 100%**

### 5.3 HHCRSP — `PUBLIC_ACADEMIC_BENCHMARK`

**341 instances** (mankowska 70 + kummer 158 + Italian 113) · **66,952 tasks** · จัดได้ 63,589

| ตัวชี้วัด | ผล |
|---|---:|
| **Invalid skill/service assignment** | **0 (0%)** |
| **Constraint satisfaction rate** | **100%** |
| Time-window pass rate | **100%** |
| Caregiver overlaps | **0** |
| Synchronization pass rate (13,833 staffed) | **100%** |
| Route validity (63,589 legs) | **100%** |
| Failures by rule | **{} ไม่มีเลย** |
| Mandatory service coverage | 94.98% |

การตัดสินว่า caregiver มีสิทธิ์ทำ service นั้นหรือไม่ ใช้ `runHardFilters`
ซึ่งเป็น **โค้ดตัวเดียวกับที่ระบบจริงใช้** ไม่ได้เขียนตรรกะแยกสำหรับ benchmark

#### ✅ ตรวจซ้ำด้วย Validator ของเจ้าของชุดข้อมูล — หลักฐานที่แข็งที่สุด

repository ของ Udine มี **Python validator ของตัวเอง** ที่ทีมเราไม่ได้เขียน

| | |
|---|---:|
| ส่ง solution ให้ตรวจ | 341 |
| ตรวจได้ | 125 |
| **VALID** | **125** |
| **INVALID** | **0** |
| ข้าม (จัดคนไม่ครบทุก patient) | 216 |
| **Validator pass rate** | **100%** |

validator บังคับว่าต้องจัดคนครบทุก patient ก่อนจึงจะยอมตรวจ instance นั้น
จึงตรวจได้เฉพาะ 125 instance ที่ greedy คุมได้ 100% — ส่วนที่เหลือรายงานว่า **ข้าม ไม่ได้นับเป็นผ่าน**

### 5.4 TrustCare Controlled — `CONTROLLED_TEST`

**120 scenarios** แบ่งตาม V6 §5 พอดี · seed `20260831` · regenerate แล้วได้ไฟล์เหมือนเดิมทุกไบต์

| กลุ่ม | ตัวชี้วัด | ผล |
|:---:|---|---:|
| **A** (30) | Hard filter accuracy | **100%** |
| **B** (25) | Pairwise ranking agreement | **100%** |
| | Score stability | **100%** |
| **C** (25) | Job ranking agreement | **100%** |
| | Preference constraint pass | **100%** |
| | **Invalid recommendation rate** | **0%** |
| **D** (20) | Mutual formula agreement | **100%** |
| | One-sided bias test | **100%** |
| | Two-direction symmetry | **100%** |
| **E** (10) | Exceptional match rule accuracy | **100%** |
| | **Safety override accuracy** | **100%** |
| | Additional cost disclosure pass | **100%** |
| **F** (10) | **Trust penalty false positive rate** | **0%** |
| | Rebook signal pass | **100%** |
| | Cold-start conformance | **100%** |

Latency p50 / p95 / p99 = **0.06 / 0.20 / 0.51 ms**

**ความหมายของตัวเลขสำคัญ 3 ตัว**

- **Invalid recommendation rate 0%** — ไม่เคยเสนองานที่ผู้ดูแลรับไม่ได้ให้ผู้ดูแลเลย
  (13 เคสครอบคลุมงานกลางคืนที่เขาไม่รับ · งานยกที่เขาปฏิเสธ · งานต่ำกว่าค่าจ้างขั้นต่ำ ·
  งานนอกรัศมี · งานที่ทักษะไม่ถึง · งานชนกับงานที่รับไว้แล้ว)
- **Safety override accuracy 100%** — ข้อยกเว้นเรื่องระยะทางไม่เคยลบล้าง hard filter ด้านความปลอดภัย
  ผู้ดูแลที่ขาดทักษะบังคับ ต่อให้เก่งแค่ไหนและ opt-in ครบ ก็ยังถูกกรองออก
- **Trust penalty false positive rate 0%** — เหตุการณ์ที่ยังไม่ยืนยัน หรือยืนยันแล้วแต่ไม่ใช่ความผิด
  ผู้ดูแล ไม่เคยทำให้ Trust Score ลดลง

> **ข้อจำกัดที่ต้องยอมรับ** — ทั้ง 120 เคสทีมเป็นคนเขียน expected label เอง
> ตัวเลข 100% หมายความว่า **"ระบบทำงานตรงตามที่สเปกเขียนไว้"**
> ไม่ได้หมายความว่า **"ระบบเลือกผู้ดูแลได้ดีในโลกจริง"**
> บนสไลด์ต้องใช้คำว่า **rule conformance** ไม่ใช่ accuracy

### 5.5 ทดสอบบนฐานข้อมูลจริง — 25/25

`scripts/supabase_smoke.js` เดิน journey สองฝั่งครบหนึ่งรอบบน Postgres จริง

seed 45 แถว → matching (persist feature values) → exceptional far match 148.72 กม.
(base 91.96 · ค่าใช้จ่ายเพิ่ม 2,585 บาท ระบุว่าเป็นประมาณการ) → privacy-safe job card →
mutual match สองฝ่าย → ประตู Care Plan → job request → accept พร้อมเหตุผล 7 ข้อที่อ้าง feature ได้ทุกข้อ →
chat สองทาง → SOS → HIGH_RISK → GPS แม่นยำต่ำไม่ escalate → review อัปเดต trust →
incident ที่ยังไม่ยืนยันไม่หักคะแนน → ยืนยันแล้วหัก → matching รอบถัดไปเห็นประวัติ

---

## 6. ที่มาของข้อมูลที่ใช้ทดสอบ

ใช้ 3 ชุด ตาม Testing Plan V6 §1 — เพราะ public dataset เพียงชุดเดียวไม่ครอบคลุมทุกด้าน

### 6.1 University of Strathclyde

| | |
|---|---|
| **ชื่อ** | Dataset of Home Care Scheduling and Routing Problems with Synchronized Visits |
| **สถาบัน** | University of Strathclyde, สหราชอาณาจักร |
| **DOI** | `10.15129/2d4885e1-bc24-414b-83ce-a846fb5c9689` |
| **แหล่ง** | https://pureportal.strath.ac.uk/en/datasets/dataset-of-home-care-scheduling-and-routing-problems-with-synchro/ |
| **ที่มาของข้อมูล** | ผู้ให้บริการ home care เอกชนในเมืองใหญ่ของสหราชอาณาจักร |
| **ช่วงเวลา** | 1–14 ตุลาคม 2017 |
| **ไฟล์** | `carers.csv` · `visits.csv` · `distance.csv` |
| **ขนาด** | 138 carers · 6,805 visits · 236 users · matrix 236×236 |

**ทำไมเลือก** — เป็นข้อมูลปฏิบัติการจริง ไม่ใช่ synthetic · มีตารางว่างของ carer · มีเวลานัดของ visit ·
มี travel matrix · มี synchronized visits · มี DOI และสถาบันชัดเจน อ้างอิงบนเวทีได้

**ใช้ทดสอบ** — availability · schedule fit · double-booking · travel feasibility · synchronized service

**ห้ามใช้ทดสอบ** — language match · budget fit · trust history · care style · mutual interest
เพราะ dataset ไม่มี field เหล่านี้

#### สิ่งที่ dataset นี้ไม่มีจริง (มาร์ก `NOT_AVAILABLE_IN_DATASET` ไม่แต่งขึ้น)

| ไม่มี | ผลกระทบ |
|---|---|
| **Time window** | CSV มีแค่ `Time` เดียวกับ `Duration` → **สมมติเป็น ±30 นาที** ทุกที่ที่รายงานตัวเลข time-window ต้องกำกับว่าเป็นสมมติฐาน |
| **ตำแหน่งบ้าน carer** | matrix เป็น user↔user ล้วน → วัด travel ได้เฉพาะระหว่างงานต่อเนื่อง ไม่ใช่จากบ้านไปงานแรก |
| **Flag synchronized** | ไม่มี field ตรง ๆ → อนุมานจาก `CarerCount = 2` (1,493 จาก 6,805 visits) |
| skills · ภาษา · งบ · trust · preference | ห้ามใช้ทดสอบ Family Fit / Job Fit / Mutual Fit |

### 6.2 University of Udine — HHCRSP

| | |
|---|---|
| **ชื่อ** | Data and Toolbox Repository for the Home Healthcare Routing and Scheduling Problem |
| **สถาบัน** | Intelligent Optimization Laboratory, Università degli Studi di Udine, อิตาลี |
| **Repository** | https://github.com/iolab-uniud/hhcrsp |
| **Commit ที่ใช้** | `d4b8e9b` — "Add DOI badge to README" |
| **Paper DOI** | `10.1111/itor.13585` — *Multi-neighborhood simulated annealing for the home healthcare routing and scheduling problem* |
| **License** | MIT |
| **ดาวน์โหลด** | 29 สิงหาคม 2026 |
| **ขนาด** | 341 instances · 872 instance files · 274 solution files · Python validator |

**ทำไมเลือก** — มี service requirement ที่ map เข้ากับ required skill ของ TrustCare ได้ดี ·
มี patient time windows · มี caregiver assignment · มี synchronization ทั้งแบบ simultaneous และ sequential ·
**มี solution validator ของตัวเอง** ซึ่งทำให้ตรวจสอบความถูกต้องแบบอิสระได้

**การ map เข้า TrustCare** (V6 §17)

```
patient.id                    → care_request_id
patient.location              → care_location
patient.time_window           → allowed_time_window
required_caregivers[].service → required_service_code (strength MANDATORY)
service duration              → task duration
caregiver.abilities           → caregiver.skills
synchronization               → simultaneous / sequential constraint
```

> **ข้อกำหนด V6 §3** — service code `s1..sN` **ไม่มีความหมายทางคลินิก** ในชุดข้อมูลนี้
> ใช้เป็น service compatibility proxy เท่านั้น
> **ห้ามอ้างว่า s1 = โรคหรือทักษะเฉพาะชนิดใด**

ไฟล์ `data/hhcrsp2/SOURCE.md` บันทึกที่มา commit และ license ไว้
โฟลเดอร์ `.git` ของ clone ถูกลบออก เพราะต้องการเฉพาะไฟล์ข้อมูล
และมันไปปรากฏใน Source Control ของ editor ทำให้สับสนว่าเป็นโค้ดของเรา

### 6.3 TrustCare Controlled Mutual Matching

| | |
|---|---|
| **ประเภท** | ชุดทดสอบที่ทีมสร้างเอง |
| **Label** | `CONTROLLED_TEST` |
| **ขนาด** | 120 scenarios |
| **Seed** | `20260831` — deterministic ทั้งหมด ไม่มี `Math.random` |
| **ไฟล์** | `data/trustcare_controlled_mutual_120.jsonl` · `.csv` |

**ทำไมจำเป็น** — ไม่มี public dataset ใดที่มี ground truth ครบสำหรับสิ่งที่ TrustCare ต้องพิสูจน์:

Family Fit · Caregiver Job Fit · Mutual Fit · budget preference · workload preference ·
language preference · continuity · hospital escort · caregiver job preference · trust history ·
previous successful match · mutual interest · exceptional far match

**การแบ่งกลุ่ม** (ตรงตาม V6 §5 พอดี)

| กลุ่ม | จำนวน | ทดสอบอะไร |
|:---:|---:|---|
| A | 30 | Hard filter — ทุกเงื่อนไขบังคับทั้ง 14 ข้อ |
| B | 25 | Family Fit — การจัดอันดับและความเสถียรของคะแนน |
| C | 25 | Caregiver Job Fit — การจัดอันดับงานและการไม่เสนองานที่รับไม่ได้ |
| D | 20 | Mutual Fit — สูตร ความลำเอียงฝั่งเดียว ความสมมาตรสองทิศทาง |
| E | 10 | Exceptional far match — กฎ ความปลอดภัย การเปิดเผยค่าใช้จ่าย |
| F | 10 | Trust history — โทษที่ผิดพลาด rebook cold-start |

> **ต้องระบุบนสไลด์เสมอ** — *"ทีมสร้างขึ้นเพื่อทดสอบ rule/ranking conformance"*
> **ไม่ใช่ real-world validation**

### 6.4 Optional — UHHC

| | |
|---|---|
| **ชื่อ** | Unified Home Healthcare Routing and Scheduling Problem Repository |
| **แหล่ง** | https://github.com/iolab-uniud/uhhc |
| **DOI** | `10.1111/itor.70140` |
| **สถานะ** | **ไม่ได้ใช้** — V6 §13 ระบุเองว่าไม่จำเป็นสำหรับการนำเสนอ |

---

## 7. ข้อจำกัดที่ต้องระบุเมื่อนำเสนอ

ตาม Testing Plan V6 §18 Section E — **ห้ามละเว้นข้อใดข้อหนึ่ง**

1. ไม่มีชุดข้อมูลใดที่มี ground truth ว่าผู้ดูแลคนไหนดีที่สุดจริง **จึงไม่มีการอ้าง accuracy ใด ๆ**
2. Strathclyde ไม่มี time window — สมมติเป็น ±30 นาที ตัวเลข time-window ทุกตัวขึ้นกับสมมติฐานนี้
3. Strathclyde ไม่มีตำแหน่งบ้าน carer — วัด travel ได้เฉพาะระหว่างงานต่อเนื่อง
4. Strathclyde ไม่มี flag synchronized — อนุมานจาก `CarerCount = 2`
5. ทั้ง Strathclyde และ HHCRSP **ไม่มี** skill level · ภาษา · งบ · trust · preference
   จึง **ไม่ได้พิสูจน์ Family Fit / Job Fit / Mutual Fit เลย** ส่วนนั้นพิสูจน์ด้วย Controlled Test เท่านั้น
6. HHCRSP service code เป็น compatibility proxy ไม่มีความหมายทางคลินิก
7. Scheduling feasibility และ service coverage สะท้อน greedy policy ไม่ใช่ optimiser
   **เทียบกับ published optimal solutions ไม่ได้**
8. Validator ของ HHCRSP ตรวจได้เฉพาะ instance ที่จัดคนครบทุก patient — 125 จาก 341
   ส่วนที่เหลือรายงานว่า **ข้าม ไม่ได้นับเป็นผ่าน**
9. Controlled 120 เคสทีมเขียนเอง ทดสอบความสอดคล้องกับสเปก
   **ไม่ใช่ผลลัพธ์ในโลกจริงหรือความพึงพอใจผู้ใช้**
10. Smart Intake · Care Advisor · report structuring พึ่งโมเดลภายนอก ไม่ deterministic
    และ **ไม่ถูกนับในตัวเลข conformance ใด ๆ**

### PRE_TUNING / POST_TUNING (V6 §14)

ตัวเลขทั้งหมดอยู่ในสถานะ **`PRE_TUNING`**

V6 §14 ห้ามปรับน้ำหนักโดยดู expected label แล้วเรียกผลว่าเป็น independent validation
ระหว่างพัฒนามีการแก้ 2 จุด และทั้งสองจุด **ไม่ได้แตะน้ำหนัก threshold หรือสูตร mutual fit เลย**

1. นิยาม `skill_level_fit` และ `experience_match` ซึ่งสเปกเดิมไม่ได้กำหนดวิธีแปลงเป็น 0–100
   *(เป็นการเขียนสเปกให้ครบ ไม่ใช่การจูน)*
2. แก้บั๊กที่ exceptional evaluator ไม่ถูกเรียกเมื่อ candidate ตกหลาย filter
   *(ผลลัพธ์เดิมถูกอยู่แล้ว ขาดแค่คำอธิบาย)*

ทุก matching run บันทึก `score_version` และ `weight_version` ไว้
ถ้าอนาคตมีการปรับน้ำหนัก ต้องรายงานเป็น `POST_TUNING_REGRESSION` และห้ามเรียกว่า independent

---

## 8. เส้นแบ่งที่ระบบรักษาไว้

### AI ห้ามยุ่งกับตัวเลข (V4 §0, §4)

บังคับด้วย **สถาปัตยกรรม** ไม่ใช่ด้วยความตั้งใจ — โมดูลเหล่านี้ไม่มีทางเรียก network ได้เลย

| GPT ห้ามทำ | บังคับอย่างไร |
|---|---|
| สร้าง Match Score | `backend/src/matching/` เป็น pure function ทั้งหมด |
| ตัดสิน Hard Filter | `hardFilters.js` ไม่ import อะไรที่เกี่ยวกับ AI |
| คำนวณ Trust Score | `trust.js` เป็นเลขคณิตล้วน |
| ตัดสิน realtime state | `monitoring.js` เป็น rule engine |

GPT ทำได้อย่างเดียวคือ **เรียบเรียงคำอธิบายจาก score breakdown ที่คำนวณเสร็จแล้ว**
และ `/api/matching/explain` **ส่งคะแนนกลับจากฝั่ง deterministic เสมอ** ไม่เคยอ่านตัวเลขจากคำตอบของโมเดล

เมื่อ AI ใช้ไม่ได้ ระบบตอบว่าใช้ไม่ได้ (`ai_available: false` + `degraded_reason`)
**ไม่แกล้งทำเป็นสำเร็จ** (V4 §52) — มี test ยืนยันข้อนี้โดยเฉพาะ

### เวลาภาษาพูดไทยไม่ฝากไว้กับ AI

การแปลง "บ่ายโมง" → `13:00` มีตัวแปลง deterministic (`lib/thaiTime.js`) ตรวจซ้ำทุกครั้ง
ถ้า AI แปลงผิด ระบบแก้กลับให้และ **รายงานว่าแก้ตรงไหน** — เพราะเวลาผิดในตารางดูแล = ให้ยาผิดเวลา

รองรับ `ตี 1-5` · `6-11 โมงเช้า` · `เที่ยง` · `เที่ยงคืน` · `บ่ายโมง` · `บ่าย 2-5` ·
`4-6 โมงเย็น` · `1-5 ทุ่ม` · `ครึ่ง` ต่อท้าย — **44 เทสต์คุมส่วนนี้โดยเฉพาะ**

### การเปิดเผยตำแหน่งเป็นขั้น

| ใครดู | เห็นอะไร |
|---|---|
| ผู้ดูแล **ก่อนตอบรับ** | พิกัดปัดลงตาราง ~1 กม. รัศมี 900 ม. **ไม่มีหมุด** |
| ผู้ดูแล **หลังตอบรับ** | พิกัดจริง + วงกลม geofence |
| ครอบครัว | พิกัดจริงเสมอ (เป็นของตัวเอง) |

ผู้ดูแลต้องรู้ว่างานอยู่แถวไหนก่อนตัดสินใจ แต่พิกัดที่แม่นยำ **ก็คือบ้านเลขที่**
**14 เทสต์คุมกฎนี้** เพราะถ้าพลาด = ที่อยู่บ้านรั่วให้ผู้ดูแลทุกคนที่เห็นงาน

### ความยินยอมสองฝ่าย

คะแนนสูงไม่ได้แปลว่าจับคู่ · `MUTUAL_MATCH` เกิดเมื่อทั้งสองฝ่ายกดสนใจเท่านั้น (V5 §5)
งานนอกพื้นที่ต้องยินยอมทั้งคู่ และถ้าต้องมีที่พักต้องตกลงก่อนจึงจะยืนยันได้ (V5 §26 case 8)

### ประตู Care Plan

ส่งคำขอไม่ได้ถ้ายังไม่มีตารางที่ยืนยันแล้ว (V4 §25) — เพื่อให้ผู้ดูแลรู้ว่าต้องทำอะไรบ้าง
และ **ห้ามบังคับให้สร้างคำขอใหม่** ต้องพากลับมาที่ผู้ดูแลคนเดิมที่เลือกไว้

---

## 9. โครงสร้างโปรเจกต์

```
TrustCare/
│
├── backend/                    Node.js 22 · Express 5 · Zod · Vitest
│   ├── src/
│   │   ├── matching/           ★ engine — pure functions ไม่มี network call
│   │   │   ├── config.js         น้ำหนัก · threshold · policy
│   │   │   ├── geo.js            haversine · distance curve
│   │   │   ├── hardFilters.js    14 เงื่อนไขบังคับ
│   │   │   ├── features.js       40 features → 0-100
│   │   │   ├── score.js          bucket → base → final
│   │   │   ├── exceptional.js    งานนอกพื้นที่ + cost estimate
│   │   │   ├── trust.js          trust score + cold-start shrinkage
│   │   │   └── engine.js         orchestration สองทิศทาง
│   │   ├── services/           matching · workflow · notifications · monitoring · AI gateway
│   │   ├── routes/             api · app · carePlan · advisor · market · board
│   │   ├── store/              memory | supabase (interface เดียวกัน)
│   │   ├── lib/                ids · thaiTime · location · env
│   │   └── seed/               ข้อมูลตัวอย่าง (V4 §40 + V5 §32)
│   └── tests/                  151 tests — แต่ละตัวอ้างอิงข้อในสเปก
│
├── ai-service/                 Python 3.12 · FastAPI · Pydantic v2
│   └── app/
│       ├── main.py             5 endpoints — ภาษาอย่างเดียว
│       ├── prompts.py          system prompts (V4 §29 verbatim)
│       └── schemas.py          Pydantic models
│
├── adapters/                   ตัวแปลงชุดข้อมูล benchmark
│   ├── strathclyde_adapter.js
│   └── hhcrsp_adapter.js
│
├── scripts/                    generate · benchmark · validate · migrate
├── db/                         7 migrations · 43 tables · 36 RLS policies
├── docs/                       FRONTEND_HANDOFF · SCORING_SPEC · migration-audit
├── reports/                    ผล benchmark (json · csv · md)
├── data/                       ชุดข้อมูล (gitignored — 1.1 GB)
├── test_Ai.md                  สรุปผลทดสอบสำหรับนำเสนอ
└── README.md                   ไฟล์นี้
```

---

## 10. การตั้งค่า

ทุกอย่างอ่านจาก `.env` (gitignored) · `.env.example` มีรายการตัวแปรครบ
**Secret ไม่เคยถูก log หรือส่งกลับ** — `/api/health` รายงานเพียงว่าตั้งค่าไว้แล้วหรือยัง

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `STORE` | `memory` | `memory` หรือ `supabase` |
| `NODE_PORT` | `3000` | พอร์ต backend |
| `PYTHON_AI_URL` | `http://localhost:8001` | ที่อยู่ AI service |
| `DEV_TESTER_ENABLED` | `true` | เปิด `/api/dev/*` — **ต้องปิดใน production** |
| `OPENAI_TEXT_MODEL` | `gpt-4o-mini` | โมเดลข้อความ |
| `OPENAI_STT_MODEL` | `gpt-4o-mini-transcribe` | โมเดลถอดเสียง |
| `MATCHING_SCORE_VERSION` | `matching-v4` | บันทึกในทุก matching run |
| `WEIGHT_PROFILE_VERSION` | `weights-v4-default` | บันทึกในทุก matching run |
| `EXCEPTIONAL_BASE_FIT_THRESHOLD` | `90` | เกณฑ์ exceptional match |
| `EXCEPTIONAL_MAX_DISTANCE_KM` | `300` | ระยะสูงสุดของแพลตฟอร์ม |
| `BUDGET_BELOW_MINIMUM_POLICY` | `FILTER` | `FILTER` หรือ `NEGOTIATION` |
| `CHAT_UNLOCK_STAGE` | `MUTUAL_MATCH` | `MUTUAL_MATCH` หรือ `JOB_ACCEPTED` |

> ### 🔒 Security
>
> API ปัจจุบันระบุตัวผู้เรียกด้วย header `x-role` / `x-actor-id`
> ซึ่งเป็นวิธีของโหมดทดสอบเท่านั้น **ยอมรับได้เฉพาะเมื่ออยู่หลัง `DEV_TESTER_ENABLED`**
>
> **Production ต้องมี Supabase Auth ครอบ API** และ RLS policies ใน
> `db/migrations/002_rls.sql` คือสิ่งที่ปกป้องข้อมูลในโหมดนั้น

---

## 11. ฐานข้อมูล

**Applied แล้ว** บน Supabase project `atsffbepeptelvtxkufv` — **42 ตาราง · 32 RLS policies**

| Migration | Statements | เนื้อหา |
|---|---:|---|
| `001_init.sql` | 71 | ตาราง · enum · index (V4 §35) |
| `002_rls.sql` | 56 | Row Level Security (V4 §38) |
| `003_stable_codes.sql` | 30 | code อ่านง่าย + คอลัมน์ workflow |
| `004_marketplace.sql` | 5 | ข้อความประกอบการสมัคร |
| `005_geofence.sql` | 3 | รัศมีเฝ้าระวัง |
| `006_search_radius.sql` | 2 | ระยะที่ครอบครัวยอมรับได้ |
| **รวม** | **167** | **0 failed** |

### วิธี apply กับ project ใหม่

```bash
pip install "psycopg[binary]" pglast
python scripts/validate_migrations.py                              # ตรวจไวยากรณ์ก่อน
SUPABASE_DB_PASSWORD='<password>' python scripts/apply_migrations.py
```

หรือ paste `db/apply_all.sql` ลง SQL editor ซึ่งไม่ต้องใช้ credential เพิ่ม

> **API key ทั้งสามแบบรัน DDL ไม่ได้** — `sb_publishable_`, `sb_secret_` และ `service_role` JWT
> วิ่งผ่าน PostgREST ทั้งหมด ต้องใช้รหัสผ่านฐานข้อมูลหรือ management token (`sbp_`)
> รายละเอียดใน [`db/README.md`](db/README.md)

### id เป็น uuid แต่รับ code ได้

ข้อมูลตัวอย่างมี `code` อ่านง่าย (`CR-01`, `CG_NEAR_01`) — API รับได้ทั้งสองแบบ
`/api/matching/CR-01/run` กับ `/api/matching/<uuid>/run` ไปที่แถวเดียวกัน
uuid สร้างแบบ UUIDv5 จาก code จึงเหมือนกันทุกเครื่องทุกครั้งที่ seed
**response คืน uuid เสมอ**

---

## 12. การส่งมอบ

### เอกสารทั้งหมด

| ไฟล์ | สำหรับใคร | เนื้อหา |
|---|---|---|
| **[`docs/FRONTEND_HANDOFF.md`](docs/FRONTEND_HANDOFF.md)** | **ทีมหน้าบ้าน** | หน้าจอที่เคยมี · 37 endpoints · กฎ 8 ข้อ · ตัวอย่าง response · ค่าคงที่ |
| [`docs/SCORING_SPEC.md`](docs/SCORING_SPEC.md) | ทุกคน | สูตร น้ำหนัก เกณฑ์ ทุกตัวเลขที่ระบบใช้ + change log |
| [`test_Ai.md`](test_Ai.md) | นำเสนอ | ผลทดสอบ · สคริปต์พูด · ตัวเลขที่แนะนำขึ้นสไลด์ |
| [`db/README.md`](db/README.md) | DevOps | schema และวิธี apply |
| [`docs/migration-audit.md`](docs/migration-audit.md) | บันทึก | การสร้างระบบและสิ่งที่ถูกลบ |
| `data/hhcrsp2/SOURCE.md` | อ้างอิง | ที่มาของชุดข้อมูล HHCRSP |

### สิ่งที่ยังไม่ได้ทำ

| ยังไม่มี | หมายเหตุ |
|---|---|
| **Auth จริง** | ⚠️ **สำคัญที่สุด** — RLS พร้อมแล้ว รอ Supabase Auth ครอบ |
| **การส่งแจ้งเตือนออกนอกระบบ** | ตัวแจ้งเตือน 13 ชนิดเก็บครบใน `notifications` แล้ว แต่ยังไม่ได้ต่อ push / email / SMS — frontend อ่านผ่าน API ได้เลย |
| **STT กับไฟล์เสียงจริง** | endpoint มีแล้ว ทดสอบผ่านข้อความได้ แต่ยังไม่เคยส่งไฟล์เสียงจริง |
| **UHHC dataset** | V6 §13 ระบุเองว่าเป็น optional |

### ก่อนส่งจริง

1. **Rotate key 3 ตัว** — OpenAI API key · Supabase service_role JWT · รหัสผ่านฐานข้อมูล
2. **อย่าส่ง `data/`** — 1.1 GB เป็นชุดข้อมูล benchmark · `SOURCE.md` บอกวิธีโหลดใหม่
3. ให้ผู้รับตั้ง `.env` ของตัวเองจาก `.env.example`

---

<div align="center">

**พัฒนาตาม** Master System Spec V4 · Ecosystem Addendum V5 · Testing & Benchmark Plan V6

*ทุกตัวเลขในเอกสารนี้มาจากการรันจริง และอ้างอิงกลับไปที่ข้อในสเปกได้*

</div>

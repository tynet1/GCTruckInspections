# Vehicle list: questions to confirm

`vehicles.csv` was built from the header table on each paper form in `reference/` (43 forms, 39 trucks, AZ002–AZ054).
VINs were checked with the standard North American check digit. The app only adds trucks that aren't in the
database yet, so after the first start, fix anything below in **Admin → Trucks** rather than in the CSV.

## Fixed in the CSV (high confidence)

| Truck | On the form | In the CSV | Why |
|---|---|---|---|
| AZ002 | VIN `3C6UR4HJ6JRG225891` (18 characters) | `3C6UR4HJ6RG225891` | Extra "J"; the corrected VIN passes the check digit and matches AZ015/AZ032. |
| AZ016 | Plate `CM2308` | `CM62308` | AZ026 → AZ020 have consecutive VINs (…523588 → …523593) and plates (CM62307 → CM62312); AZ016 sits between CM62307 and CM62309. |
| AZ026 | Unit `28Q ZJG` | `28QZJG` | Stray space. |

## Need someone to confirm

| Truck | Issue |
|---|---|
| AZ003 | VIN `3C63RPGL2RG228790` fails the check digit (should be 4 in position 9 if the rest is right). One character is probably mistyped. Check the title or registration. |
| AZ004, AZ028, AZ035 | Each has two forms: an older "Nissan 5ft/6ft" (Feb 2025) and a newer "Nissan King Cab" (Oct–Dec 2025). The CSV uses the **King Cab** diagram because it's newer. AZ028's King Cab form has a VIN typo (`16NED…`) and AZ035's King Cab VIN is cut short, so the CSV uses the VIN from the older form for those two. |
| AZ043 / AZ047 | Both forms have the same unit, VIN and plate (`25XS76`, `1N6ED1CL0NN649620`, `L8A64J`). AZ047 is in the CSV with those fields blank until the real values are known. |
| AZ006 / AZ008 | Both forms show unit `22CTDL`. |
| AZ008 | Form says 2025 Ram 2500; the VIN's 10th character (`R`) decodes to model year 2024. |
| AZ025, AZ039 | Forms say Ram **2500**, but the VINs match the 1500s (AZ049 and AZ022/AZ040). |
| AZ032 | Plate `T3A5FT8` has 7 characters; the other 2024 Rams have 6. |
| "Nissan 5ft" forms (AZ004, AZ011, AZ027, AZ028) | Header says "2 DR EXT", but the diagram on the form is a 4-door crew cab. |
| Registration dates | Most forms leave Expiration blank. AZ003 and AZ010 show 2/28/2025, and AZ008/018/019/020/026 show 3/15/2026, so all seven show **Reg expired** in the app until updated. AZ050/AZ054 say "04/30" with no year (left blank). |
| Pulls trailer | Set to yes for every Ram (their forms have the trailer page) and no for the Nissans and the F-650 (one-page forms). Crews can still switch the trailer section on per inspection. |
| Not in `reference/` | The spec mentions AZ070 (Isuzu NPR, registration Feb 2021, VIN decodes to 1999) and an International 4900. Neither has a form here, so neither is in the CSV. |

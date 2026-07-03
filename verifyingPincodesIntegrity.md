Loading AllIndiaPincodeDataSet.csv ...

==============================================================================
1. SCHEMA CHECK — does this file match what the PRD assumed?
==============================================================================
Rows: 165,627
Expected columns present: 11/11

==============================================================================
2. PINCODE FORMAT — are all pincodes clean 6-digit strings? (blocks §5.1 CHECK constraint)
==============================================================================
Valid 6-digit pincodes: 165,627 / 165,627
Invalid format:         0
Unique pincodes: 19,586

==============================================================================
3. OFFICETYPE VOCABULARY — is it really only BO/PO? (THE key blocker for §5.2 tiering)
==============================================================================
Distinct officetype values and counts:
  'BO'                 -> 140,270
  'PO'                 -> 24,546
  'HO'                 -> 811

=> officetype vocabulary is ONLY {BO, PO}: False
   (If True, this confirms the PRD's finding: no HO/SO distinction in this column.
    Tiering must come from officename suffixes instead, or fall back to averaging.)

==============================================================================
4. OFFICENAME SUFFIX PATTERNS — does H.O/S.O/G.P.O granularity live in the name string?
==============================================================================
  Suffix B.O / BO      : 134,705 rows match
      e.g. ['Kothimir B.O', 'Papanpet B.O', 'Kukuda B.O', 'Bareguda B.O', 'Mosam B.O']
  Suffix S.O / SO      : 22,230 rows match
      e.g. ['Jharkhand Vidhan Sabha SO', 'Khunti SO', 'Railway Colony Hatia SO', 'Ranchi Airport SO', 'Bharno SO']
  Suffix H.O / HO      : 786 rows match
      e.g. [' NDC Lucknow Chowk Ho', 'NDC Coimbatore HO', 'Mancherial H.O', 'Mahabubnagar H.O', 'Nalgonda H.O']
  Suffix G.P.O / GPO   : 33 rows match
      e.g. ['NDC Jaipur GPO', 'Delhi GPO', 'Thiruvananthapuram GPO', 'Nagpur GPO', 'Chandigarh GPO']
  Suffix T.O / TO      : 0 rows match

  officetype -> suffixes seen inside officename for that type:
    'BO'   -> ['B.O / BO', 'S.O / SO']
    'PO'   -> ['B.O / BO', 'S.O / SO', 'H.O / HO', 'G.P.O / GPO']
    'HO'   -> ['H.O / HO', 'G.P.O / GPO']

==============================================================================
5. COORDINATE COVERAGE — nulls, out-of-bounds, and (0,0) placeholder values
==============================================================================
Rows with null latitude:        12,013
Rows with null longitude:       12,008
Rows with either null:          12,015 (7.3%)
Rows with both present:         153,612
Rows at exactly (0,0)-ish:       13  <- these are placeholder junk, not real coords
Rows outside India bounding box: 2,602  <- these would VIOLATE the §5.1 CHECK constraints
  Sample out-of-box rows:
pincode      statename   latitude  longitude
 506169      TELANGANA 79.0000000 17.0000000
 506168      TELANGANA 35.8968000 61.2536900
 506356      TELANGANA 39.5698000 58.6359000
 503164      TELANGANA 18.1690283 18.1690283
 535557 ANDHRA PRADESH 83.5297000 18.6149000
 535557 ANDHRA PRADESH 83.5183000 18.6153000
 535559 ANDHRA PRADESH 83.4133000 18.5267000
 535128 ANDHRA PRADESH 83.6018000 18.3700000
 535578 ANDHRA PRADESH 83.3531000 18.4836000
 535578 ANDHRA PRADESH 83.3531000 18.4836000

==============================================================================
6. PINCODES WITH ZERO VALID COORDINATES AT ALL — must be excluded per PRD §5.2 step 4
==============================================================================
Total distinct pincodes:                    19,586
Pincodes with NO valid coordinate anywhere: 36 (0.18%)
  -> these must be excluded from the seed entirely (PRD §5.2 step 4), and logged.

==============================================================================
7. OFFICES-PER-PINCODE DISTRIBUTION — how many pincodes need tie-breaking logic at all?
==============================================================================
count    19586.000000
mean         8.456397
std          7.254741
min          1.000000
25%          3.000000
50%          7.000000
75%         11.000000
max        153.000000

Pincodes with exactly 1 office (no tie-break needed): 2,143
Pincodes with 2+ offices (tie-break/averaging applies): 17,443

==============================================================================
8. DRY RUN — actually resolving each pincode the way the seed script would
==============================================================================
Pincodes resolved via a real priority signal: 15,683
Pincodes resolved via averaging (no usable tier signal): 3,867
Pincodes excluded (zero valid coords):                   36

Total pincodes that WOULD be seeded: 19,550

==============================================================================
9. STATE / DISTRICT COVERAGE SANITY
==============================================================================
Distinct statename values: 36
Top 10 by row count:
statename
UTTAR PRADESH     17968
MAHARASHTRA       13762
TAMIL NADU        11733
RAJASTHAN         11032
ANDHRA PRADESH    10681
MADHYA PRADESH    10272
KARNATAKA          9658
BIHAR              9309
ODISHA             8915
GUJARAT            8841

==============================================================================
DONE
==============================================================================
Full machine-readable report written to: pincode_profile_report.json
Paste that JSON file's contents back into the chat, or just paste
the printed report above — either is enough to finalize the PRD's
open items (§5.2 tiering, §5.1 constraints, §8 risk sizing).

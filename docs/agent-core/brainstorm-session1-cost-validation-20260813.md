# Brainstorm: cheaper alternative for long-term media storage (AWS S3 deep archive + serverless vs Google/Apple cloud storage)
Date: 2026-08-13 13:34
Technique(s) used: TBD

## [MAIN] cheaper alternative for long-term media storage (AWS S3 deep archive + serverless vs Google/Apple cloud storage)


## [MAIN] Cheaper alternative for long-term media storage
Techniques in use: Free Association, Reverse Brainstorm, Six Thinking Hats, SCAMPER

### Free Association batch 1
- Idea: Adaptive compression by content type (RAW vs phone video vs screenshots) rather than one blanket codec/quality
- Idea: Real cost driver may be retrieval patterns, not storage class — deep archive retrieval fees could dwarf storage savings the one time you pull data back
- Idea: Treat archive like game save files — rare full backups + frequent incremental deltas
- Idea: Batch the spot-EC2 compression farm monthly/quarterly instead of always-on, to kill idle compute cost
- Idea: Real competitor may not be Google/Apple but a home NAS + single offsite Glacier copy
- Idea: DynamoDB as a "smart index" (perceptual hash, thumbnails in S3 Standard) so you rarely touch Deep Archive at all
- Idea: AI dedup/near-duplicate detection to shrink volume before it's ever archived
- Idea: Flip the economics — one-time engineering cost, then near-free marginal storage forever vs perpetual subscription
- Idea: Build the validation as a spreadsheet model keyed on "how many times/year will I actually restore" — this number decides everything
- Idea: Reframe as a product — could others pay for this cheaper alternative too?

### Provocative questions
- If you'll never retrieve 90% of this data again, does $/GB even matter more than confidence it's safe?
- Does Apple/Google's price already bundle things you're not pricing into your own system (your time, egress, spot interruptions, hardware depreciation)?
- What if the DIY system fails silently for 2 years and you only find out when the one irreplaceable video is gone?

### Six Thinking Hats — White Hat (facts)
- Deep Archive ~$0.00099/GB-mo → 6TB ≈ $6/mo storage vs Google One 5TB / iCloud 6TB ≈ $25-30/mo class
- Hidden costs: retrieval fees, restore-to-standard copies, egress out of AWS, PUT/lifecycle request fees, DynamoDB, Lambda, spot instances
- Deep Archive minimums: 180-day storage minimum, per-object overhead makes millions of tiny files costly → argues for bundling into tars
- Retrieval trap theme: cheap to store, expensive/slow (12-48h) to get back

## Final Summary
Total ideas: 15 | Forks: 0 | Techniques: Free Association, Six Thinking Hats (White Hat)

### Key themes
1. The raw storage gap is real (~$6/mo Deep Archive vs ~$25-30/mo Google/Apple for 5-6TB) but the true cost battleground is retrieval: fees, egress, and 12-48h restore times.
2. Architecture shape matters more than services: bundle small files into large archives, keep a hot "smart index" (thumbnails + metadata in DynamoDB/S3 Standard), touch Deep Archive rarely.
3. Validation reduces to one number: expected restores per year — plus honest accounting for your own time, silent-failure risk, and what Apple/Google bundle (browsability, sharing, apps).
4. Volume reduction before archiving (dedup, near-duplicate detection, adaptive per-content-type compression via batched spot jobs) compounds all savings.
5. Possible bigger play: this could be a product for others, not just a personal system.

// src/db/utils/spatial.js
//
// Proximity search is now performed inline inside listing.service.js
// (searchListings) using COALESCE(l.location, p.location) with a geography
// cast so that pg_room and hostel_bed listings inherit their parent property's
// coordinates. No standalone helper is needed here.

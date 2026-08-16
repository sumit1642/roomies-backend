import { getTier, resolveCoordinate, resolvePincode } from "./pincodes.js";

describe("getTier", () => {
	test("officetype HO is tier 0 regardless of name", () => {
		expect(getTier("HO", "Random Name")).toBe(0);
	});
	test("H.O / GPO suffix is tier 0", () => {
		expect(getTier("BO", " NDC Lucknow Chowk Ho")).toBe(0);
		expect(getTier("PO", "Delhi GPO")).toBe(0);
	});
	test("S.O suffix is tier 1", () => {
		expect(getTier("PO", "Khunti SO")).toBe(1);
	});
	test("B.O suffix or BO type with no suffix match is tier 2", () => {
		expect(getTier("BO", "Kothimir B.O")).toBe(2);
		expect(getTier("BO", "Some Village")).toBe(2);
	});
	test("unranked type/name falls to tier 3", () => {
		expect(getTier("XX", "Nothing Matching")).toBe(3);
	});
});

describe("resolveCoordinate", () => {
	test("in-bounds pair is used as-is", () => {
		expect(resolveCoordinate(17.0, 79.0)).toEqual({
			latitude: 17.0,
			longitude: 79.0,
			swapped: false,
			usable: true,
		});
	});
	test("swapped pair is corrected when the swap lands in-bounds", () => {
		expect(resolveCoordinate(79.0, 17.0)).toEqual({ latitude: 17.0, longitude: 79.0, swapped: true, usable: true });
	});
	test("garbage coordinate (e.g. 0,0) is unusable", () => {
		expect(resolveCoordinate(0, 0)).toEqual({ latitude: null, longitude: null, swapped: false, usable: false });
	});
});

describe("resolvePincode", () => {
	test("excludes a pincode with zero valid coordinates anywhere", () => {
		const result = resolvePincode("999999", [
			{ officetype: "BO", officename: "Junk B.O", district: "D", statename: "S", latitude: 0, longitude: 0 },
		]);
		expect(result.excluded).toBe(true);
		expect(result.officeCount).toBe(1);
	});

	test("resolves via priority tier when a higher tier narrows the pool", () => {
		const rows = [
			{ officetype: "HO", officename: "Town HO", district: "D", statename: "S", latitude: 17.0, longitude: 79.0 },
			{
				officetype: "BO",
				officename: "Far Village B.O",
				district: "D",
				statename: "S",
				latitude: 17.5,
				longitude: 79.5,
			},
		];
		const result = resolvePincode("500001", rows);
		expect(result.excluded).toBe(false);
		expect(result.resolution).toBe("priority");
		expect(result.latitude).toBeCloseTo(17.0);
		expect(result.longitude).toBeCloseTo(79.0);
	});

	test("falls back to averaged when no tier narrows the usable pool", () => {
		const rows = [
			{ officetype: "XX", officename: "Place A", district: "D", statename: "S", latitude: 17.0, longitude: 79.0 },
			{ officetype: "XX", officename: "Place B", district: "D", statename: "S", latitude: 18.0, longitude: 80.0 },
		];
		const result = resolvePincode("500002", rows);
		expect(result.resolution).toBe("averaged");
		expect(result.latitude).toBeCloseTo(17.5);
		expect(result.longitude).toBeCloseTo(80.5 - 0.5); // (79+80)/2 = 79.5
	});

	test("swapCorrected reflects only rows contributing to the centroid, not losing-tier rows", () => {
		const rows = [
			// Winning tier (HO): clean, no swap.
			{ officetype: "HO", officename: "Town HO", district: "D", statename: "S", latitude: 17.0, longitude: 79.0 },
			// Losing tier (BO): swap-corrected, should NOT flip swapCorrected to true.
			{ officetype: "BO", officename: "Far B.O", district: "D", statename: "S", latitude: 79.5, longitude: 17.5 },
		];
		const result = resolvePincode("500003", rows);
		expect(result.swapCorrected).toBe(false);
	});

	test("swapCorrected is true when the winning-tier row itself was swap-corrected", () => {
		const rows = [
			{ officetype: "HO", officename: "Town HO", district: "D", statename: "S", latitude: 79.0, longitude: 17.0 },
		];
		const result = resolvePincode("500004", rows);
		expect(result.swapCorrected).toBe(true);
	});
});

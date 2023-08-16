"use strict";

class ItemParser extends BaseParser {
	static init (itemData, classData) {
		ItemParser._ALL_ITEMS = itemData;
		ItemParser._ALL_CLASSES = classData.class;
	}

	static getItem (itemName) {
		itemName = itemName.trim().toLowerCase();
		itemName = ItemParser._MAPPED_ITEM_NAMES[itemName] || itemName;
		const matches = ItemParser._ALL_ITEMS.filter(it => it.name.toLowerCase() === itemName);
		if (matches.length > 1) throw new Error(`Multiple items found with name "${itemName}"`);
		if (matches.length) return matches[0];
		return null;
	}

	/**
	 * Parses items from raw text pastes
	 * @param inText Input text.
	 * @param options Options object.
	 * @param options.cbWarning Warning callback.
	 * @param options.cbOutput Output callback.
	 * @param options.isAppend Default output append mode.
	 * @param options.source Entity source.
	 * @param options.page Entity page.
	 * @param options.titleCaseFields Array of fields to be title-cased in this entity (if enabled).
	 * @param options.isTitleCase Whether title-case fields should be title-cased in this entity.
	 */
	static doParseText (inText, options) {
		options = this._getValidOptions(options);

		if (!inText || !inText.trim()) return options.cbWarning("No input!");
		const toConvert = this._getCleanInput(inText, options)
			.split("\n")
			.filter(it => it && it.trim());
		const item = {};
		item.source = options.source;
		// for the user to fill out
		item.page = options.page;

		// FIXME this duplicates functionality in converterutils
		let prevLine = null;
		let curLine = null;
		let i;
		for (i = 0; i < toConvert.length; i++) {
			prevLine = curLine;
			curLine = toConvert[i].trim();

			if (curLine === "") continue;

			// name of item
			if (i === 0) {
				item.name = this._getAsTitle("name", curLine, options.titleCaseFields, options.isTitleCase);
				continue;
			}

			// tagline
			if (i === 1) {
				this._setCleanTaglineInfo(item, curLine, options);
				continue;
			}

			const ptrI = {_: i};
			item.entries = EntryConvert.coalesceLines(
				ptrI,
				toConvert,
			);
			i = ptrI._;
		}

		const statsOut = this._getFinalState(item, options);
		options.cbOutput(statsOut, options.isAppend);
	}

	static _getFinalState (item, options) {
		if (!item.entries.length) delete item.entries;
		else this._setWeight(item, options);

		if (item.staff) this._setQuarterstaffStats(item, options);
		this._mutRemoveBaseItemProps(item, options);

		this._doItemPostProcess(item, options);
		this._setCleanTaglineInfo_handleGenericType(item, options);
		this._doVariantPostProcess(item, options);
		return PropOrder.getOrdered(item, item.__prop || "item");
	}

	// SHARED UTILITY FUNCTIONS ////////////////////////////////////////////////////////////////////////////////////////
	static _doItemPostProcess (stats, options) {
		TagCondition.tryTagConditions(stats);
		ArtifactPropertiesTag.tryRun(stats);
		if (stats.entries) {
			stats.entries = stats.entries.map(it => DiceConvert.getTaggedEntry(it));
			EntryConvert.tryRun(stats, "entries");
			stats.entries = SkillTag.tryRun(stats.entries);
			stats.entries = ActionTag.tryRun(stats.entries);
			stats.entries = SenseTag.tryRun(stats.entries);

			if (/is a (tiny|small|medium|large|huge|gargantuan) object/.test(JSON.stringify(stats.entries))) options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Item may be an object!`);
		}
		this._doItemPostProcess_addTags(stats, options);
		BasicTextClean.tryRun(stats);
	}

	static _doItemPostProcess_addTags (stats, options) {
		const manName = stats.name ? `(${stats.name}) ` : "";
		ChargeTag.tryRun(stats);
		RechargeTypeTag.tryRun(stats, {cbMan: () => options.cbWarning(`${manName}Recharge type requires manual conversion`)});
		RechargeAmountTag.tryRun(stats, {cbMan: () => options.cbWarning(`${manName}Recharge amount requires manual conversion`)});
		BonusTag.tryRun(stats);
		ItemMiscTag.tryRun(stats);
		ItemSpellcastingFocusTag.tryRun(stats);
		DamageResistanceTag.tryRun(stats, {cbMan: () => options.cbWarning(`${manName}Damage resistance tagging requires manual conversion`)});
		DamageImmunityTag.tryRun(stats, {cbMan: () => options.cbWarning(`${manName}Damage immunity tagging requires manual conversion`)});
		DamageVulnerabilityTag.tryRun(stats, {cbMan: () => options.cbWarning(`${manName}Damage vulnerability tagging requires manual conversion`)});
		ConditionImmunityTag.tryRun(stats, {cbMan: () => options.cbWarning(`${manName}Condition immunity tagging requires manual conversion`)});
		ReqAttuneTagTag.tryRun(stats, {cbMan: () => options.cbWarning(`${manName}Attunement requirement tagging requires manual conversion`)});
		TagJsons.mutTagObject(stats, {keySet: new Set(["entries"]), isOptimistic: false});
		AttachedSpellTag.tryRun(stats);

		// TODO
		//  - tag damage type?
		//  - tag ability score adjustments
	}

	static _doVariantPostProcess (stats, options) {
		if (!stats.inherits) return;
		BonusTag.tryRun(stats, {isVariant: true});
	}

	// SHARED PARSING FUNCTIONS ////////////////////////////////////////////////////////////////////////////////////////
	static _setCleanTaglineInfo (stats, curLine, options) {
		const parts = curLine.split(",").map(it => it.trim()).filter(Boolean);

		const handlePartRarity = (rarity) => {
			rarity = rarity.trim().toLowerCase();
			switch (rarity) {
				case "common": stats.rarity = rarity; return true;
				case "uncommon": stats.rarity = rarity; return true;
				case "rare": stats.rarity = rarity; return true;
				case "very rare": stats.rarity = rarity; return true;
				case "legendary": stats.rarity = rarity; return true;
				case "artifact": stats.rarity = rarity; return true;
				case "varies":
				case "rarity varies": {
					stats.rarity = "varies";
					stats.__prop = "itemGroup";
					return true;
				}
				case "unknown rarity": {
					// Make a best-guess as to whether or not the item is magical
					if (stats.wondrous || stats.staff || stats.type === "P" || stats.type === "RG" || stats.type === "RD" || stats.type === "WD" || stats.type === "SC" || stats.type === "MR") stats.rarity = "unknown (magic)";
					else stats.rarity = "unknown";
					return true;
				}
			}
			return false;
		};

		let baseItem = null;

		for (let i = 0; i < parts.length; ++i) {
			let part = parts[i];
			const partLower = part.toLowerCase();

			// region wondrous/item type/staff/etc.
			switch (partLower) {
				case "wondrous item": stats.wondrous = true; continue;
				case "wondrous item (tattoo)": stats.wondrous = true; stats.tattoo = true; continue;
				case "potion": stats.type = "P"; continue;
				case "ring": stats.type = "RG"; continue;
				case "rod": stats.type = "RD"; continue;
				case "wand": stats.type = "WD"; continue;
				case "ammunition": stats.type = "A"; continue;
				case "staff": stats.staff = true; continue;
				case "master rune": stats.type = "MR"; continue;
				case "scroll": stats.type = "SC"; continue;
			}
			// endregion

			// region rarity/attunement
			// Check if the part is an exact match for a rarity string
			const isHandledRarity = handlePartRarity(partLower);
			if (isHandledRarity) continue;

			if (partLower.includes("(requires attunement")) {
				const [rarityRaw, ...rest] = part.split("(");
				const rarity = rarityRaw.trim().toLowerCase();

				const isHandledRarity = rarity ? handlePartRarity(rarity) : true;
				if (!isHandledRarity) options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Rarity "${rarityRaw}" requires manual conversion`);

				let attunement = rest.join("(");
				attunement = attunement.replace(/^requires attunement/i, "").replace(/\)/, "").trim();
				if (!attunement) {
					stats.reqAttune = true;
				} else {
					stats.reqAttune = attunement.toLowerCase();
				}

				// if specific attunement is required, absorb any further parts which are class names
				if (/(^| )by a /i.test(stats.reqAttune)) {
					for (let ii = i; ii < parts.length; ++ii) {
						const nxtPart = parts[ii]
							.trim()
							.replace(/^(?:or|and) /, "")
							.trim()
							.replace(/\)$/, "")
							.trim();
						const isClassName = ItemParser._ALL_CLASSES.some(cls => cls.name.toLowerCase() === nxtPart);
						if (isClassName) {
							stats.reqAttune += `, ${parts[ii].replace(/\)$/, "")}`;
							i = ii;
						}
					}
				}

				continue;
			}
			// endregion

			// region weapon/armor
			if (partLower === "weapon" || partLower === "weapon (any)") {
				(stats.requires ||= []).push(...this._setCleanTaglineInfo_getGenericRequires({stats, str: "weapon", options}));
				stats.__genericType = true;
				continue;
			} else if (/^armou?r(?: \(any\))?$/.test(partLower)) {
				(stats.requires ||= []).push(...this._setCleanTaglineInfo_getGenericRequires({stats, str: "armor", options}));
				stats.__genericType = true;
				continue;
			} else {
				const mWeaponAnyX = /^weapon \(any ([^)]+)\)$/i.exec(part);
				if (mWeaponAnyX) {
					(stats.requires ||= []).push(...this._setCleanTaglineInfo_getGenericRequires({stats, str: mWeaponAnyX[1].trim().toCamelCase(), options}));
					stats.__genericType = true;
					continue;
				}
			}

			const mBaseWeapon = /^(weapon|staff) \(([^)]+)\)$/i.exec(part);
			if (mBaseWeapon) {
				if (mBaseWeapon[1].toLowerCase() === "staff") stats.staff = true;
				baseItem = ItemParser.getItem(mBaseWeapon[2]);
				if (!baseItem) throw new Error(`Could not find base item "${mBaseWeapon[2]}"`);
				continue;
			}

			const mBaseArmor = /^armou?r \((?<type>[^)]+)\)$/i.exec(part);
			if (mBaseArmor) {
				if (this._setCleanTaglineInfo_isMutAnyArmor(stats, mBaseArmor)) {
					stats.__genericType = true;
					continue;
				}

				baseItem = this._setCleanTaglineInfo_getArmorBaseItem(mBaseArmor.groups.type);
				if (!baseItem) throw new Error(`Could not find base item "${mBaseArmor.groups.type}"`);
				continue;
			}
			// endregion

			// Warn about any unprocessed input
			options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Tagline part "${part}" requires manual conversion`);
		}

		this._setCleanTaglineInfo_handleBaseItem(stats, baseItem, options);
	}

	static _setCleanTaglineInfo_getArmorBaseItem (name) {
		let baseItem = ItemParser.getItem(name);
		if (!baseItem) baseItem = ItemParser.getItem(`${name} armor`); // "armor (plate)" -> "plate armor"
		return baseItem;
	}

	static _setCleanTaglineInfo_getProcArmorPart ({pt}) {
		switch (pt) {
			case "light": return {"type": "LA"};
			case "medium": return {"type": "MA"};
			case "heavy": return {"type": "HA"};
			default: {
				const baseItem = this._setCleanTaglineInfo_getArmorBaseItem(pt);
				if (!baseItem) throw new Error(`Could not find base item "${pt}"`);

				return {name: baseItem.name};
			}
		}
	}

	static _setCleanTaglineInfo_isMutAnyArmor (stats, mBaseArmor) {
		if (/^any /i.test(mBaseArmor.groups.type)) {
			const ptAny = mBaseArmor.groups.type.replace(/^any /i, "");
			const [ptInclude, ptExclude] = ptAny.split(/\bexcept\b/i).map(it => it.trim()).filter(Boolean);

			if (ptInclude) {
				stats.requires = [
					...(stats.requires || []),
					...ptInclude.split(/\b(?:or|,)\b/g).map(it => it.trim()).filter(Boolean).map(it => this._setCleanTaglineInfo_getProcArmorPart({pt: it})),
				];
			}

			if (ptExclude) {
				Object.assign(
					stats.excludes = stats.excludes || {},
					ptExclude.split(/\b(?:or|,)\b/g).map(it => it.trim()).filter(Boolean).mergeMap(it => this._setCleanTaglineInfo_getProcArmorPart({pt: it})),
				);
			}

			return true;
		}

		if (/^(?:light|medium|heavy)$/i.test(mBaseArmor.groups.type)) {
			stats.requires = [
				...(stats.requires || []),
				this._setCleanTaglineInfo_getProcArmorPart({pt: mBaseArmor.groups.type}),
			];

			return true;
		}

		return false;
	}

	static _setCleanTaglineInfo_handleBaseItem (stats, baseItem, options) {
		if (!baseItem) return;

		const blocklistedProps = new Set([
			"source",
			"srd",
			"basicRules",
			"page",
		]);

		// Apply base item stats only if there's no existing data
		Object.entries(baseItem)
			.filter(([k]) => stats[k] === undefined && !k.startsWith("_") && !blocklistedProps.has(k))
			.forEach(([k, v]) => stats[k] = v);

		// Clean unwanted base properties
		delete stats.armor;
		delete stats.value;

		stats.baseItem = `${baseItem.name.toLowerCase()}${baseItem.source === Parser.SRC_DMG ? "" : `|${baseItem.source}`}`;
	}

	static _setCleanTaglineInfo_getGenericRequires ({stats, str, options}) {
		switch (str) {
			case "weapon": return [{"weapon": true}];
			case "sword": return [{"sword": true}];
			case "axe": return [{"axe": true}];
			case "armor": return [{"armor": true}];
			case "bow": return [{"bow": true}, {"crossbow": true}];
			case "bludgeoning": return [{"dmgType": "B"}];
			case "piercing": return [{"dmgType": "P"}];
			case "slashing": return [{"dmgType": "S"}];
			default: {
				options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Tagline part "${str}" requires manual conversion`);
				return [{[str]: true}];
			}
		}
	}

	static _setCleanTaglineInfo_handleGenericType (stats, options) {
		if (!stats.__genericType) return;
		delete stats.__genericType;

		let prefixSuffixName = stats.name;
		prefixSuffixName = prefixSuffixName
			.replace(/^(weapon|armor) /i, "")
			.replace(/ (weapon|armor)$/i, "");
		const isSuffix = /^\s*of /i.test(prefixSuffixName);

		stats.inherits = MiscUtil.copy(stats);
		// Clean/move inherit props into inherits object
		["name", "requires", "excludes"].forEach(prop => delete stats.inherits[prop]); // maintain some props on base object
		Object.keys(stats.inherits).forEach(k => delete stats[k]);

		if (isSuffix) stats.inherits.nameSuffix = ` ${prefixSuffixName.trim()}`;
		else stats.inherits.namePrefix = `${prefixSuffixName.trim()} `;

		stats.__prop = "magicvariant";
		stats.type = "GV";
	}

	static _setWeight (stats, options) {
		const strEntries = JSON.stringify(stats.entries);

		strEntries.replace(/weighs ([a-zA-Z0-9,]+) (pounds?|lbs?\.|tons?)/, (...m) => {
			if (m[2].toLowerCase().trim().startsWith("ton")) throw new Error(`Handling for tonnage is unimplemented!`);

			const noCommas = m[1].replace(/,/g, "");
			if (!isNaN(noCommas)) stats.weight = Number(noCommas);

			const fromText = Parser.textToNumber(m[1]);
			if (!isNaN(fromText)) stats.weight = fromText;

			if (!stats.weight) options.cbWarning(`${stats.name ? `(${stats.name}) ` : ""}Weight "${m[1]}" requires manual conversion`);
		});
	}

	static _setQuarterstaffStats (stats) {
		const cpyStatsQuarterstaff = MiscUtil.copy(ItemParser._ALL_ITEMS.find(it => it.name === "Quarterstaff" && it.source === Parser.SRC_PHB));

		// remove unwanted properties
		delete cpyStatsQuarterstaff.name;
		delete cpyStatsQuarterstaff.source;
		delete cpyStatsQuarterstaff.page;
		delete cpyStatsQuarterstaff.rarity;
		delete cpyStatsQuarterstaff.value;
		delete cpyStatsQuarterstaff.srd;
		delete cpyStatsQuarterstaff.basicRules;

		Object.entries(cpyStatsQuarterstaff)
			.filter(([k]) => !k.startsWith("_"))
			.forEach(([k, v]) => {
				if (stats[k] == null) stats[k] = v;
			});
	}

	static _mutRemoveBaseItemProps (stats) {
		if (stats.__prop === "baseitem") return;

		// region tags found only on basic items
		delete stats.weapon;
		delete stats.dagger;
		delete stats.bow;
		delete stats.spear;
		delete stats.sword;
		delete stats.axe;
		delete stats.mace;
		// endregion
	}
}
ItemParser._ALL_ITEMS = null;
ItemParser._ALL_CLASSES = null;
ItemParser._MAPPED_ITEM_NAMES = {
	"studded leather": "studded leather armor",
	"leather": "leather armor",
	"scale": "scale mail",
};

globalThis.ItemParser = ItemParser;

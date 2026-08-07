import { getCompanyBySlug } from '$db/repo';
import type { Company } from '$db/schema';

/**
 * Loads the airline named in the URL. Every company-scoped screen reads this,
 * so switching airlines is just a navigation.
 */
export const loadCompany = async (slug: string): Promise<Company | undefined> =>
	getCompanyBySlug(slug);

export interface CompanyCounters {
	fleetSize: number;
	deliveringCount: number;
	routeCount: number;
	gateCount: number;
	pendingIncidents: number;
}

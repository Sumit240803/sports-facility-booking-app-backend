import { supabaseAdmin } from '../lib/supabase.js';

// Sports and amenities share the same shape and rules
export type CatalogTable = 'sports' | 'amenities';

export interface CatalogItem {
    id: string;
    name: string;
    is_active: boolean;
    sort_order: number;
    created_at: string;
}

export const listCatalog = async (table: CatalogTable, includeInactive = false): Promise<CatalogItem[]> => {
    let query = supabaseAdmin.from(table).select('*').order('sort_order').order('name');
    if (!includeInactive) query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) throw error;
    return data as CatalogItem[];
};

export const createCatalogItem = async (
    table: CatalogTable,
    item: { id: string; name: string; sort_order?: number | undefined },
): Promise<CatalogItem> => {
    const { data, error } = await supabaseAdmin.from(table).insert(item).select('*').single();
    if (error) throw error;
    return data as CatalogItem;
};

export const updateCatalogItem = async (
    table: CatalogTable,
    id: string,
    changes: { name?: string | undefined; is_active?: boolean | undefined; sort_order?: number | undefined },
): Promise<CatalogItem | null> => {
    const { data, error } = await supabaseAdmin.from(table).update(changes).eq('id', id).select('*').maybeSingle();
    if (error) throw error;
    return data as CatalogItem | null;
};

// Returns the ids from the list that are not active catalog entries
export const findInvalidIds = async (table: CatalogTable, ids: string[]): Promise<string[]> => {
    if (ids.length === 0) return [];
    const { data, error } = await supabaseAdmin.from(table).select('id').in('id', ids).eq('is_active', true);
    if (error) throw error;
    const valid = new Set((data as { id: string }[]).map((r) => r.id));
    return ids.filter((id) => !valid.has(id));
};

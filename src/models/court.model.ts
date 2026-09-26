import { supabaseAdmin } from '../lib/supabase.js';

export interface Court {
    id: string;
    venue_id: string;
    name: string;
    sport_id: string;
    is_indoor: boolean;
    surface: string | null;
    capacity: number | null;
    base_slot_minutes: 30 | 60;
    min_duration_minutes: number;
    max_duration_minutes: number;
    price_per_hour_paise: number | null;
    uses_venue_hours: boolean;
    is_active: boolean;
    sort_order: number;
    deleted_at: string | null;
    created_at: string;
    updated_at: string;
}

export type CourtInput = Partial<Pick<Court,
    'name' | 'sport_id' | 'is_indoor' | 'surface' | 'capacity' | 'base_slot_minutes' |
    'min_duration_minutes' | 'max_duration_minutes' | 'price_per_hour_paise' | 'is_active' | 'sort_order'>>;

export const listCourts = async (venueId: string): Promise<Court[]> => {
    const { data, error } = await supabaseAdmin
        .from('courts')
        .select('*')
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .order('sort_order')
        .order('created_at');
    if (error) throw error;
    return data as Court[];
};

export const findCourt = async (venueId: string, courtId: string): Promise<Court | null> => {
    const { data, error } = await supabaseAdmin
        .from('courts')
        .select('*')
        .eq('id', courtId)
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .maybeSingle();
    if (error) throw error;
    return data as Court | null;
};

export const createCourt = async (venueId: string, input: CourtInput): Promise<Court> => {
    const { data, error } = await supabaseAdmin.from('courts').insert({ ...input, venue_id: venueId }).select('*').single();
    if (error) throw error;
    return data as Court;
};

export const updateCourt = async (venueId: string, courtId: string, changes: CourtInput & { deleted_at?: string }): Promise<Court | null> => {
    const { data, error } = await supabaseAdmin
        .from('courts')
        .update(changes)
        .eq('id', courtId)
        .eq('venue_id', venueId)
        .is('deleted_at', null)
        .select('*')
        .maybeSingle();
    if (error) throw error;
    return data as Court | null;
};

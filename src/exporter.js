import fs from 'fs/promises';
import path from 'path';

export async function saveFile(data, format, savePath) {
    const fullPath = path.resolve(savePath);
    
    try {
        if (format === 'json') {
            await fs.writeFile(fullPath, JSON.stringify(data, null, 2));
        } else if (format === 'csv') {
            // Simple flat CSV converter
            if (data.length === 0) return;
            const headers = Object.keys(data[0]).join(',');
            const rows = data.map(obj => Object.values(obj).map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
            const csvContent = [headers, ...rows].join('\n');
            await fs.writeFile(fullPath, csvContent);
        }
        return fullPath;
    } catch (error) {
        throw new Error(`Failed to save file: ${error.message}`);
    }
}
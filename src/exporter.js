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
			// Gather all unique keys from the entire dataset
			const allKeys = new Set();
			data.forEach(obj => {
				Object.keys(obj).forEach(key => allKeys.add(key));
			});
			const headers = Array.from(allKeys).join(',');
			const rows = data.map(obj =>
				Array.from(allKeys).map(key => {
					const val = obj[key];
					let strVal;
					if (val === null || val === undefined) {
						strVal = '';
					} else if (typeof val === 'object') {
						strVal = JSON.stringify(val);
					} else {
						strVal = String(val);
					}
					return `"${strVal.replace(/"/g, '""')}"`;
				}).join(',')
			);
            const csvContent = [headers, ...rows].join('\n');
            await fs.writeFile(fullPath, csvContent);
        }
        return fullPath;
    } catch (error) {
        throw new Error(`Failed to save file: ${error.message}`);
    }
}
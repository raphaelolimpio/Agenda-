function getUtcWeekday(dateValue) {
    if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;

    const [year, month, day] = dateValue.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return null;
    }

    return date.getUTCDay();
}

module.exports = { getUtcWeekday };

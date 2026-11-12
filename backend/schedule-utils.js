const { getUtcWeekday } = require('./date-utils');

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isValidScheduleBlock(block) {
    if (!block || typeof block !== 'object'
        || !['dia', 'horario'].includes(block.tipoAlvo)
        || !['especifico', 'semana_recorrente', 'diario_recorrente'].includes(block.tipoRecorrencia)
        || typeof block.motivo !== 'string' || block.motivo.trim().length > 120) {
        return false;
    }

    const value = String(block.valor ?? '');
    if (block.tipoRecorrencia === 'especifico' && getUtcWeekday(value) === null) return false;
    if (block.tipoRecorrencia === 'semana_recorrente' && !/^[0-6]$/.test(value)) return false;
    if (block.tipoRecorrencia === 'diario_recorrente' && value !== 'todos_os_dias' && value !== 'todos') return false;
    if (block.tipoAlvo === 'horario'
        && (!TIME_PATTERN.test(block.horaInicio || '') || !TIME_PATTERN.test(block.horaFim || '')
            || block.horaInicio === block.horaFim)) {
        return false;
    }

    return true;
}

function recurrenceMatches(block, date) {
    if (block.tipoRecorrencia === 'especifico') return String(block.valor) === date;
    if (block.tipoRecorrencia === 'semana_recorrente') {
        return Number(block.valor) === getUtcWeekday(date);
    }
    return block.tipoRecorrencia === 'diario_recorrente';
}

function dayNumber(date) {
    const [year, month, day] = date.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dateFromDayNumber(value) {
    return new Date(value * 86_400_000).toISOString().slice(0, 10);
}

function timeInMinutes(value) {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
}

function isBlockedPeriod(blocks, date, startMinute, endMinute) {
    const currentDay = dayNumber(date);
    const requestedStart = currentDay * 1440 + startMinute;
    const requestedEnd = currentDay * 1440 + endMinute;

    return blocks.some((block) => {
        for (const baseDay of [currentDay - 1, currentDay]) {
            const baseDate = dateFromDayNumber(baseDay);
            if (!recurrenceMatches(block, baseDate)) continue;
            if (block.tipoAlvo === 'dia') {
                if (baseDay === currentDay) return true;
                continue;
            }

            const blockStartMinute = timeInMinutes(block.horaInicio);
            const blockEndMinute = timeInMinutes(block.horaFim);
            const intervalStart = baseDay * 1440 + blockStartMinute;
            const intervalEnd = baseDay * 1440 + blockEndMinute
                + (blockEndMinute <= blockStartMinute ? 1440 : 0);
            if (requestedStart < intervalEnd && requestedEnd > intervalStart) return true;
        }
        return false;
    });
}

function appointmentOverlaps(date, startMinute, endMinute, appointment) {
    const appointmentStart = (dayNumber(appointment.local_date) - dayNumber(date)) * 1440
        + timeInMinutes(appointment.start_time);
    const appointmentEnd = (dayNumber(appointment.end_date || appointment.local_date) - dayNumber(date)) * 1440
        + timeInMinutes(appointment.end_time);
    return startMinute < appointmentEnd && endMinute > appointmentStart;
}

function appointmentBlocksProfessional(appointment, professional, currentSpaceId) {
    if (String(appointment.space_id) !== String(currentSpaceId)) {
        return professional?.type === 'employee'
            && appointment.saas_professional_type === 'employee'
            && String(appointment.saas_professional_id).toLowerCase() === professional.id.toLowerCase();
    }
    if (!professional || !appointment.saas_professional_id) return true;
    return appointment.saas_professional_type === professional.type
        && String(appointment.saas_professional_id).toLowerCase() === professional.id.toLowerCase();
}

module.exports = {
    TIME_PATTERN,
    appointmentBlocksProfessional,
    appointmentOverlaps,
    getUtcWeekday,
    isBlockedPeriod,
    isValidScheduleBlock
};

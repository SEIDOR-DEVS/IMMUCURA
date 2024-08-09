
import axios from 'axios';

// Configuration
const API_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJ0aWQiOjM4MDc4NjY5OSwiYWFpIjoxMSwidWlkIjo2MTc4Mjg2MywiaWFkIjoiMjAyNC0wNy0wNVQxMDo0ODozOS45ODJaIiwicGVyIjoibWU6d3JpdGUiLCJhY3RpZCI6MjM0MzU5ODksInJnbiI6ImV1YzEifQ.eJrUmEPlK16IF1-0q69IiLbpeKFdf46NyOCnKY6kTrk';
const API_URL = 'https://api.monday.com/v2';
const BOARD_ID = 1556223297; // Your board ID
const COLUMN_ID = 'archivo2__1'; // The column ID you want to clear

// Function to get all item IDs from a board
async function getItemIds(boardId) {
    try {
        const response = await axios.post(API_URL, {
            query: `
                query {
                    boards(ids: ${boardId}) {
                        items_page(limit: 500) {
                            items {
                                id
                                name
                            }
                        }
                    }
                }
            `
        }, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.data.errors) {
            console.error('GraphQL errors:', response.data.errors);
            return [];
        }

        const items = response.data.data.boards[0].items_page.items;
        console.log(`Retrieved ${items.length} items from board ${boardId}`);
        return items.map(item => item.id);
    } catch (error) {
        console.error('Error retrieving item IDs:', error.response ? error.response.data : error.message);
        return [];
    }
}

// Function to clear a column value for a specific item
async function clearColumnForItem(boardId, itemId, columnId) {
    try {
        const response = await axios.post(API_URL, {
            query: `
                mutation {
                    change_column_value(board_id: ${boardId}, item_id: ${itemId}, column_id: "${columnId}", value: "{\\"clear_all\\":true}") {
                        id
                    }
                }
            `
        }, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`Cleared column for item ${itemId}:`, response.data);
    } catch (error) {
        console.error(`Error clearing column for item ${itemId}:`, error.response ? error.response.data : error.message);
    }
}

// Main function to clear all column values for the board
async function clearAllColumnsForBoard(boardId, columnId) {
    const itemIds = await getItemIds(boardId);

    if (itemIds.length === 0) {
        console.log('No items found to clear.');
        return;
    }

    for (const itemId of itemIds) {
        await clearColumnForItem(boardId, itemId, columnId);
    }

    console.log('All columns have been cleared.');
}

// Execute the function
clearAllColumnsForBoard(BOARD_ID, COLUMN_ID);
